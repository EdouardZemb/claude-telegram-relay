/**
 * Voice Transcription & TTS Test
 *
 * Verifies the chosen voice provider and TTS are configured correctly.
 * Run: bun run test:voice
 */

import "dotenv/config";
import { unlink } from "fs/promises";

const VOICE_PROVIDER = process.env.VOICE_PROVIDER || "";
const TTS_PROVIDER = process.env.TTS_PROVIDER || "";

async function testGroq(): Promise<boolean> {
  if (!process.env.GROQ_API_KEY) {
    console.error("GROQ_API_KEY is not set in .env");
    return false;
  }

  try {
    const Groq = (await import("groq-sdk")).default;
    const groq = new Groq();

    // List models to verify the API key works
    const models = await groq.models.list();
    const whisper = models.data.find((m) => m.id === "whisper-large-v3-turbo");

    if (!whisper) {
      console.error("whisper-large-v3-turbo model not found on Groq");
      return false;
    }

    console.log("Groq API key is valid");
    console.log("Model: whisper-large-v3-turbo available");
    return true;
  } catch (error: any) {
    console.error("Groq API error:", error.message || error);
    return false;
  }
}

async function testLocal(): Promise<boolean> {
  const whisperBinary = process.env.WHISPER_BINARY || "whisper-cpp";
  const modelPath = process.env.WHISPER_MODEL_PATH || "";
  let allGood = true;

  // Check ffmpeg
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    console.log("ffmpeg: installed");
  } catch {
    console.error("ffmpeg: NOT FOUND — install with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)");
    allGood = false;
  }

  // Check whisper binary
  try {
    const proc = Bun.spawn([whisperBinary, "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    console.log(`${whisperBinary}: installed`);
  } catch {
    console.error(`${whisperBinary}: NOT FOUND — install with: brew install whisper-cpp (macOS) or build from source`);
    allGood = false;
  }

  // Check model file
  if (!modelPath) {
    console.error("WHISPER_MODEL_PATH not set in .env");
    allGood = false;
  } else {
    const file = Bun.file(modelPath);
    if (await file.exists()) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      console.log(`Model: ${modelPath} (${sizeMB} MB)`);
    } else {
      console.error(`Model not found: ${modelPath}`);
      console.error(
        "Download with: curl -L -o " +
          modelPath +
          " https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
      );
      allGood = false;
    }
  }

  return allGood;
}

async function testTTS(): Promise<boolean> {
  const piperBinary = process.env.PIPER_BINARY || "piper";
  const modelPath = process.env.PIPER_MODEL_PATH || "";
  let allGood = true;

  // Check piper binary
  try {
    const proc = Bun.spawn([piperBinary, "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    console.log(`${piperBinary}: installed`);
  } catch {
    console.error(`${piperBinary}: NOT FOUND — download from https://github.com/rhasspy/piper/releases`);
    allGood = false;
  }

  // Check model files
  if (!modelPath) {
    console.error("PIPER_MODEL_PATH not set in .env");
    allGood = false;
  } else {
    const onnxFile = Bun.file(modelPath);
    const jsonFile = Bun.file(modelPath + ".json");

    if (await onnxFile.exists()) {
      const sizeMB = (onnxFile.size / 1024 / 1024).toFixed(1);
      console.log(`Piper model: ${modelPath} (${sizeMB} MB)`);
    } else {
      console.error(`Piper model not found: ${modelPath}`);
      allGood = false;
    }

    if (await jsonFile.exists()) {
      console.log(`Piper config: ${modelPath}.json`);
    } else {
      console.error(`Piper config not found: ${modelPath}.json`);
      allGood = false;
    }
  }

  // Test synthesis if binary and model are available
  if (allGood) {
    try {
      const testWav = `/tmp/tts_test_${Date.now()}.wav`;
      const proc = Bun.spawn(
        [piperBinary, "--model", modelPath, "--output_file", testWav],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
      );

      proc.stdin.write("Test de synthèse vocale.");
      proc.stdin.end();

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const wavFile = Bun.file(testWav);
        if (await wavFile.exists()) {
          const sizeKB = (wavFile.size / 1024).toFixed(1);
          console.log(`TTS synthesis test: OK (${sizeKB} KB WAV)`);
          await unlink(testWav).catch(() => {});
        }
      } else {
        const stderr = await new Response(proc.stderr).text();
        console.error(`TTS synthesis test failed: ${stderr}`);
        allGood = false;
      }
    } catch (error: any) {
      console.error(`TTS synthesis test error: ${error.message || error}`);
      allGood = false;
    }
  }

  return allGood;
}

// ---- Main ----

console.log("Voice Transcription & TTS Test\n");

// === Transcription ===

console.log("=== Transcription ===\n");

if (!VOICE_PROVIDER) {
  console.log("VOICE_PROVIDER is not set in .env — voice transcription is disabled.");
  console.log('To enable, set VOICE_PROVIDER=groq or VOICE_PROVIDER=local in .env\n');
} else {
  console.log(`Provider: ${VOICE_PROVIDER}\n`);
}

let transcriptionPassed = false;

if (VOICE_PROVIDER === "groq") {
  transcriptionPassed = await testGroq();
} else if (VOICE_PROVIDER === "local") {
  transcriptionPassed = await testLocal();
} else if (VOICE_PROVIDER) {
  console.error(`Unknown VOICE_PROVIDER: "${VOICE_PROVIDER}"`);
  console.log('Valid options: "groq" or "local"');
}

if (VOICE_PROVIDER) {
  if (transcriptionPassed) {
    console.log("\nTranscription: PASSED");
  } else {
    console.error("\nTranscription: FAILED");
  }
}

// === TTS ===

console.log("\n=== Text-to-Speech ===\n");

let ttsPassed = false;

if (!TTS_PROVIDER) {
  console.log("TTS_PROVIDER is not set in .env — TTS is disabled.");
  console.log('To enable, set TTS_PROVIDER=local in .env\n');
} else {
  console.log(`TTS Provider: ${TTS_PROVIDER}\n`);

  if (TTS_PROVIDER === "local") {
    ttsPassed = await testTTS();
  } else {
    console.error(`Unknown TTS_PROVIDER: "${TTS_PROVIDER}"`);
    console.log('Valid options: "local"');
  }

  if (ttsPassed) {
    console.log("\nTTS: PASSED");
  } else {
    console.error("\nTTS: FAILED");
  }
}

// === Summary ===

console.log("\n=== Summary ===\n");

const anyFailed =
  (VOICE_PROVIDER && !transcriptionPassed) || (TTS_PROVIDER && !ttsPassed);

if (anyFailed) {
  console.error("Some tests failed. Fix the issues above.");
  process.exit(1);
} else {
  console.log("All configured voice features are ready.");
}
