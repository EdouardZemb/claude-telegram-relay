/**
 * Text-to-Speech Module
 *
 * Routes to Piper TTS (local) based on TTS_PROVIDER env var.
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

  if (TTS_PROVIDER === "local") {
    return synthesizeLocal(text);
  }

  console.error(`Unknown TTS_PROVIDER: ${TTS_PROVIDER}`);
  return null;
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
