/**
 * @module tts
 * @description Text-to-speech via Groq cloud (primary) or Piper local (fallback).
 */

/**
 * Text-to-Speech Module
 *
 * Routes to Groq TTS (cloud) or Piper (local) based on TTS_PROVIDER env var.
 * When TTS_PROVIDER=groq, falls back to Piper on network/API errors.
 * Architecture mirrors src/transcribe.ts.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";

const TTS_PROVIDER = process.env.TTS_PROVIDER || "";

/**
 * Synthesize text to an OGG/Opus audio buffer.
 * Returns null if TTS is not configured or fails.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  if (!TTS_PROVIDER) return null;

  // Guard: empty or whitespace-only text would crash Piper
  if (!text || !text.trim()) {
    console.warn("TTS: skipping empty text");
    return null;
  }

  if (TTS_PROVIDER === "groq") {
    return synthesizeGroq(text);
  }

  if (TTS_PROVIDER === "local") {
    return synthesizeLocal(text);
  }

  console.error(`Unknown TTS_PROVIDER: ${TTS_PROVIDER}`);
  return null;
}

// Split text into chunks of max ~200 chars, breaking at sentence boundaries
function splitTextForGroq(text: string, maxLen = 190): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at sentence boundary (. ! ? followed by space)
    let splitAt = -1;
    for (let i = maxLen; i >= 40; i--) {
      if (".!?".includes(remaining[i - 1]!) && (i >= remaining.length || remaining[i] === " " || remaining[i] === "\n")) {
        splitAt = i;
        break;
      }
    }

    // Fallback: split at last space before maxLen
    if (splitAt === -1) {
      for (let i = maxLen; i >= 40; i--) {
        if (remaining[i] === " ") {
          splitAt = i + 1;
          break;
        }
      }
    }

    // Last resort: hard split
    if (splitAt === -1) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

async function synthesizeGroqChunk(text: string, apiKey: string, model: string, voice: string): Promise<Buffer | null> {
  const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "wav",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    console.error(`Groq TTS API error (${response.status}): ${errorText}`);
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeGroq(text: string): Promise<Buffer | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("TTS: GROQ_API_KEY not set, falling back to local");
    return synthesizeLocal(text);
  }

  const voice = process.env.GROQ_TTS_VOICE || "diana";
  const model = process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-v1-english";

  try {
    const chunks = splitTextForGroq(text);
    const wavBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      const wav = await synthesizeGroqChunk(chunk, apiKey, model, voice);
      if (!wav) {
        console.warn("TTS: Groq chunk failed, falling back to local");
        return synthesizeLocal(text);
      }
      wavBuffers.push(wav);
    }

    // If single chunk, use it directly
    const timestamp = Date.now();
    const tmpDir = process.env.TMPDIR || "/tmp";
    const oggPath = join(tmpDir, `tts_groq_${timestamp}.ogg`);
    const tempFiles: string[] = [];

    try {
      let wavPath: string;

      if (wavBuffers.length === 1) {
        wavPath = join(tmpDir, `tts_groq_${timestamp}.wav`);
        await writeFile(wavPath, wavBuffers[0]!);
        tempFiles.push(wavPath);
      } else {
        // Write each chunk WAV and concatenate with ffmpeg
        const chunkPaths: string[] = [];
        for (let i = 0; i < wavBuffers.length; i++) {
          const p = join(tmpDir, `tts_groq_${timestamp}_${i}.wav`);
          await writeFile(p, wavBuffers[i]!);
          chunkPaths.push(p);
          tempFiles.push(p);
        }

        // Build ffmpeg concat filter
        const concatPath = join(tmpDir, `tts_groq_${timestamp}_concat.txt`);
        const concatContent = chunkPaths.map(p => `file '${p}'`).join("\n");
        await writeFile(concatPath, concatContent);
        tempFiles.push(concatPath);

        wavPath = join(tmpDir, `tts_groq_${timestamp}_merged.wav`);
        tempFiles.push(wavPath);

        const concat = spawn(
          ["ffmpeg", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", "-y", wavPath],
          { stdout: "pipe", stderr: "pipe" }
        );
        const concatExit = await concat.exited;
        if (concatExit !== 0) {
          console.error("ffmpeg concat failed");
          console.warn("TTS: falling back to local");
          return synthesizeLocal(text);
        }
      }

      // Convert WAV → OGG/Opus
      tempFiles.push(oggPath);
      const ffmpeg = spawn(
        ["ffmpeg", "-i", wavPath, "-c:a", "libopus", "-b:a", "64k", "-y", oggPath],
        { stdout: "pipe", stderr: "pipe" }
      );
      const ffmpegExit = await ffmpeg.exited;
      if (ffmpegExit !== 0) {
        const stderr = await new Response(ffmpeg.stderr).text();
        console.error(`ffmpeg (Groq TTS) failed (code ${ffmpegExit}): ${stderr}`);
        console.warn("TTS: falling back to local");
        return synthesizeLocal(text);
      }

      const oggBuffer = await readFile(oggPath);
      return Buffer.from(oggBuffer);
    } finally {
      await Promise.all(tempFiles.map(f => unlink(f).catch(() => {})));
    }
  } catch (err) {
    console.error(`Groq TTS network error: ${err}`);
    console.warn("TTS: falling back to local");
    return synthesizeLocal(text);
  }
}

async function synthesizeLocal(text: string): Promise<Buffer | null> {
  const piperBinary = process.env.PIPER_BINARY || "piper";
  const modelPath = process.env.PIPER_MODEL_PATH || "";

  if (!modelPath) {
    console.error("PIPER_MODEL_PATH not set");
    return null;
  }

  const timestamp = Date.now();
  const tmpDir = process.env.TMPDIR || "/tmp";
  const wavPath = join(tmpDir, `tts_${timestamp}.wav`);
  const oggPath = join(tmpDir, `tts_${timestamp}.ogg`);

  try {
    // Piper: text via stdin → WAV file
    const piper = spawn(
      [piperBinary, "--model", modelPath, "--output_file", wavPath],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Write text to piper's stdin and close it
    piper.stdin.write(text);
    piper.stdin.end();

    const piperExit = await piper.exited;
    if (piperExit !== 0) {
      const stderr = await new Response(piper.stderr).text();
      console.error(`Piper failed (code ${piperExit}): ${stderr}`);
      return null;
    }

    // Convert WAV → OGG/Opus via ffmpeg
    const ffmpeg = spawn(
      ["ffmpeg", "-i", wavPath, "-c:a", "libopus", "-b:a", "64k", "-y", oggPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ffmpegExit = await ffmpeg.exited;
    if (ffmpegExit !== 0) {
      const stderr = await new Response(ffmpeg.stderr).text();
      console.error(`ffmpeg (TTS) failed (code ${ffmpegExit}): ${stderr}`);
      return null;
    }

    // Read the OGG file and return as buffer
    const oggBuffer = await readFile(oggPath);
    return Buffer.from(oggBuffer);
  } finally {
    // Cleanup temp files
    await unlink(wavPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}
