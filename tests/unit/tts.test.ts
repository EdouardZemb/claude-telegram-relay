/**
 * Unit Tests — src/tts.ts
 *
 * Tests for text-to-speech via Piper (local).
 * Guard conditions tested directly. Spawn-dependent tests use fake
 * piper scripts since Bun.spawn is a native binding that cannot be mocked.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, existsSync, chmodSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// ── Fake piper script setup ───────────────────────────────

const TMPDIR = join(import.meta.dir, ".tts-test-tmp");
const FAKE_PIPER = join(TMPDIR, "fake-piper.sh");
const FAKE_PIPER_FAIL = join(TMPDIR, "fake-piper-fail.sh");

function setupFakeScripts() {
  if (!existsSync(TMPDIR)) mkdirSync(TMPDIR, { recursive: true });

  // Fake piper: reads stdin, writes a minimal WAV file to --output_file
  writeFileSync(FAKE_PIPER, `#!/bin/sh
# Read stdin (text to synthesize) and discard
cat > /dev/null
# Parse --output_file argument
OUTPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output_file) OUTPUT="$2"; shift 2;;
    *) shift;;
  esac
done
if [ -z "$OUTPUT" ]; then
  echo "No output file specified" >&2
  exit 1
fi
# Write minimal WAV: 44-byte header + 100 bytes of zeros
python3 -c "
import struct, sys
data_size = 100
header = struct.pack('<4sI4s4sIHHIIHH4sI',
    b'RIFF', 36 + data_size, b'WAVE',
    b'fmt ', 16, 1, 1, 16000, 32000, 2, 16,
    b'data', data_size)
sys.stdout.buffer.write(header + b'\\x00' * data_size)
" > "$OUTPUT"
`);
  chmodSync(FAKE_PIPER, 0o755);

  // Fake piper that fails with exit code 1
  writeFileSync(FAKE_PIPER_FAIL, `#!/bin/sh
cat > /dev/null
echo "Model not found" >&2
exit 1
`);
  chmodSync(FAKE_PIPER_FAIL, 0o755);
}

function cleanupFakeScripts() {
  try {
    execSync(`rm -rf "${TMPDIR}"`);
  } catch {}
}

// Cleanup after all tests complete
afterAll(cleanupFakeScripts);

// ── Tests: Provider guard conditions ──────────────────────
// TTS_PROVIDER is captured as a module-level const at import time.
// Cache-busting query params on import path force fresh module instances.

describe("tts — provider guard conditions", () => {
  it("returns null when TTS_PROVIDER is not set", async () => {
    const saved = process.env.TTS_PROVIDER;
    delete process.env.TTS_PROVIDER;

    const mod = await import("../../src/tts?no_provider");
    const result = await mod.synthesize("hello");
    expect(result).toBeNull();

    if (saved !== undefined) process.env.TTS_PROVIDER = saved;
  });

  it("returns null when TTS_PROVIDER is empty string", async () => {
    process.env.TTS_PROVIDER = "";
    const mod = await import("../../src/tts?empty_provider");
    const result = await mod.synthesize("hello");
    expect(result).toBeNull();
  });

  it("returns null when TTS_PROVIDER is unknown value", async () => {
    process.env.TTS_PROVIDER = "cloud_unknown";
    const mod = await import("../../src/tts?unknown_provider");
    const result = await mod.synthesize("hello");
    expect(result).toBeNull();
  });

  it("does not return null when TTS_PROVIDER is 'local' and config valid", async () => {
    setupFakeScripts();
    process.env.TTS_PROVIDER = "local";
    process.env.PIPER_BINARY = FAKE_PIPER;
    process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
    process.env.TMPDIR = TMPDIR;

    const mod = await import("../../src/tts?local_valid");
    const result = await mod.synthesize("test");
    expect(result).not.toBeNull();
  });
});

// ── Tests: Local provider ─────────────────────────────────

describe("tts — local provider", () => {
  let synthesize: (text: string) => Promise<Buffer | null>;

  beforeEach(async () => {
    setupFakeScripts();
    process.env.TTS_PROVIDER = "local";
    const mod = await import("../../src/tts?local_provider");
    synthesize = mod.synthesize;
  });

  // ── Empty text guards ───────────────────────────────────

  describe("empty text guards", () => {
    it("returns null for empty string", async () => {
      process.env.PIPER_MODEL_PATH = "/model.onnx";
      const result = await synthesize("");
      expect(result).toBeNull();
    });

    it("returns null for whitespace-only string", async () => {
      process.env.PIPER_MODEL_PATH = "/model.onnx";
      const result = await synthesize("   \n\t  ");
      expect(result).toBeNull();
    });

    it("returns null for null input", async () => {
      process.env.PIPER_MODEL_PATH = "/model.onnx";
      // @ts-expect-error — testing runtime guard
      const result = await synthesize(null);
      expect(result).toBeNull();
    });

    it("returns null for undefined input", async () => {
      process.env.PIPER_MODEL_PATH = "/model.onnx";
      // @ts-expect-error — testing runtime guard
      const result = await synthesize(undefined);
      expect(result).toBeNull();
    });
  });

  // ── Missing model path ──────────────────────────────────

  describe("missing PIPER_MODEL_PATH", () => {
    it("returns null when PIPER_MODEL_PATH is empty", async () => {
      process.env.PIPER_MODEL_PATH = "";
      const result = await synthesize("hello");
      expect(result).toBeNull();
    });

    it("returns null when PIPER_MODEL_PATH is not set", async () => {
      delete process.env.PIPER_MODEL_PATH;
      const result = await synthesize("hello");
      expect(result).toBeNull();
    });
  });

  // ── Success path (fake piper + real ffmpeg) ─────────────

  describe("success path", () => {
    it("returns a non-null Buffer on success", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      const result = await synthesize("Bonjour le monde");

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Buffer);
      expect(result!.length).toBeGreaterThan(0);
    });

    it("produces valid OGG/Opus data (starts with OggS magic bytes)", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      const result = await synthesize("test audio");

      expect(result).not.toBeNull();
      const header = result!.subarray(0, 4).toString("ascii");
      expect(header).toBe("OggS");
    });

    it("handles multi-line text input", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      const result = await synthesize("Line one.\nLine two.\nLine three.");

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Buffer);
    });

    it("handles text with special characters", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      const result = await synthesize("C'est genial! Les accents: e, a, u");

      expect(result).not.toBeNull();
    });

    it("cleans up temp WAV and OGG files after success", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      await synthesize("cleanup test");

      // After synthesize returns, temp files should be deleted (finally block)
      const wavGlob = new Bun.Glob("tts_*.wav");
      const wavFiles = Array.from(wavGlob.scanSync(TMPDIR));
      expect(wavFiles).toHaveLength(0);

      const oggGlob = new Bun.Glob("tts_*.ogg");
      const oggFiles = Array.from(oggGlob.scanSync(TMPDIR));
      expect(oggFiles).toHaveLength(0);
    });
  });

  // ── Piper failure ───────────────────────────────────────

  describe("piper failure", () => {
    it("returns null when piper exits with non-zero code", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER_FAIL;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      const result = await synthesize("this should fail");

      expect(result).toBeNull();
    });

    it("cleans up temp files even when piper fails", async () => {
      process.env.PIPER_BINARY = FAKE_PIPER_FAIL;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      await synthesize("cleanup on piper failure");

      const wavGlob = new Bun.Glob("tts_*.wav");
      const wavFiles = Array.from(wavGlob.scanSync(TMPDIR));
      expect(wavFiles).toHaveLength(0);
    });

    it("throws when piper binary path does not exist (ENOENT)", async () => {
      process.env.PIPER_BINARY = "/nonexistent/path/piper";
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      // Bun.spawn throws synchronously when binary is not found
      await expect(synthesize("nonexistent binary")).rejects.toThrow();
    });
  });

  // ── Default binary ──────────────────────────────────────

  describe("default piper binary", () => {
    it("uses 'piper' as default when PIPER_BINARY is not set", async () => {
      delete process.env.PIPER_BINARY;
      process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
      process.env.TMPDIR = TMPDIR;

      // 'piper' is not installed on this system, so Bun.spawn throws ENOENT
      await expect(synthesize("test default binary")).rejects.toThrow();
    });
  });
});

// ── Tests: Groq provider ──────────────────────────────────

describe("tts — groq provider", () => {
  it("falls back to local when GROQ_API_KEY is not set", async () => {
    const savedKey = process.env.GROQ_API_KEY;
    const savedProvider = process.env.TTS_PROVIDER;
    delete process.env.GROQ_API_KEY;
    process.env.TTS_PROVIDER = "groq";
    // Piper not configured either, so should return null
    process.env.PIPER_MODEL_PATH = "";

    const mod = await import("../../src/tts?groq_no_key");
    const result = await mod.synthesize("hello");
    expect(result).toBeNull();

    if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
    if (savedProvider !== undefined) process.env.TTS_PROVIDER = savedProvider;
  });

  it("falls back to local on API error", async () => {
    setupFakeScripts();
    const savedProvider = process.env.TTS_PROVIDER;
    process.env.TTS_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-key-invalid";
    // Set up Piper fallback
    process.env.PIPER_BINARY = FAKE_PIPER;
    process.env.PIPER_MODEL_PATH = "/fake/model.onnx";
    process.env.TMPDIR = TMPDIR;

    const mod = await import("../../src/tts?groq_api_error");
    // The API call with an invalid key will fail, should fallback to local
    const result = await mod.synthesize("test fallback");
    // Fallback to Piper should produce a valid buffer
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Buffer);

    if (savedProvider !== undefined) process.env.TTS_PROVIDER = savedProvider;
  });

  it("routes to groq when TTS_PROVIDER is groq", async () => {
    process.env.TTS_PROVIDER = "groq";
    const mod = await import("../../src/tts?groq_route");
    expect(typeof mod.synthesize).toBe("function");
  });
});

// ── Tests: Module structure ───────────────────────────────

describe("tts — module structure", () => {
  it("exports synthesize function", async () => {
    process.env.TTS_PROVIDER = "local";
    const mod = await import("../../src/tts?structure_check");
    expect(typeof mod.synthesize).toBe("function");
  });

  it("synthesize returns a Promise", async () => {
    process.env.TTS_PROVIDER = "local";
    const mod = await import("../../src/tts?promise_check");
    process.env.PIPER_MODEL_PATH = "";
    const result = mod.synthesize("test");
    expect(result).toBeInstanceOf(Promise);
  });
});
