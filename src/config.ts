/**
 * @module config
 * @description Centralized environment variable validation via Zod.
 * Exports a lazy singleton getConfig() — validation runs only on first call,
 * not at module load time. This ensures tests that import transitively through
 * bot-context.ts do not crash if required env vars are absent.
 *
 * Usage:
 *   import { getConfig } from "./config.ts";
 *   const cfg = getConfig();
 *   cfg.telegramBotToken // string
 */

import { z } from "zod";

// ============================================================
// SCHEMAS
// ============================================================

/** Variables whose absence must fail the bot boot. */
const RequiredEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_USER_ID: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
});

/** Variables with sensible defaults — absence degrades a feature but does not prevent boot. */
const OptionalEnvSchema = z.object({
  USER_NAME: z.string().default(""),
  USER_TIMEZONE: z.string().default(""),
  TELEGRAM_GROUP_ID: z.string().default(""),
  SPRINT_THREAD_ID: z.coerce.number().default(0),
  DEV_THREAD_ID: z.coerce.number().default(0),
  IDEAS_THREAD_ID: z.coerce.number().default(0),
  SERVER_THREAD_ID: z.coerce.number().default(0),
  CLAUDE_PATH: z.string().default("claude"),
  PROJECT_DIR: z.string().default(""),
  RELAY_DIR: z.string().default(""),
  VOICE_PROVIDER: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  GROQ_TTS_VOICE: z.string().default(""),
  GROQ_TTS_MODEL: z.string().default(""),
  TTS_PROVIDER: z.string().default(""),
  PIPER_BINARY: z.string().default(""),
  PIPER_MODEL_PATH: z.string().default(""),
  WHISPER_BINARY: z.string().default(""),
  WHISPER_MODEL_PATH: z.string().default(""),
  WHISPER_LANGUAGE: z.string().default(""),
  GITHUB_REPO: z.string().default(""),
  GITHUB_PROJECT_NUMBER: z.coerce.number().default(0),
  NODE_ENV: z.string().default(""),
  LOG_LEVEL: z.string().default(""),
  HEARTBEAT_DEBUG: z.string().default(""),
  TMPDIR: z.string().default(""),
  MATURATION_DIR: z.string().default(""),
});

// ============================================================
// CONFIG TYPE
// ============================================================

export type AppConfig = {
  // Required
  telegramBotToken: string;
  telegramUserId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;

  // Optional
  userName: string;
  userTimezone: string;
  telegramGroupId: string;
  sprintThreadId: number;
  devThreadId: number;
  ideasThreadId: number;
  serverThreadId: number;
  claudePath: string;
  projectDir: string;
  relayDir: string;
  voiceProvider: string;
  groqApiKey: string;
  groqTtsVoice: string;
  groqTtsModel: string;
  ttsProvider: string;
  piperBinary: string;
  piperModelPath: string;
  whisperBinary: string;
  whisperModelPath: string;
  whisperLanguage: string;
  githubRepo: string;
  githubProjectNumber: number;
  nodeEnv: string;
  logLevel: string;
  heartbeatDebug: string;
  tmpDir: string;
  maturationDir: string;
};

// ============================================================
// LAZY SINGLETON
// ============================================================

let _config: AppConfig | null = null;

/**
 * Returns the validated application configuration.
 * Validation is performed on the first call only (lazy singleton).
 * Throws ConfigurationError if a required env var is absent.
 */
export function getConfig(): AppConfig {
  if (_config !== null) {
    return _config;
  }

  // Validate required env vars — throws on first missing variable
  const requiredResult = RequiredEnvSchema.safeParse(process.env);
  if (!requiredResult.success) {
    const missing = requiredResult.error.errors
      .map((e) => e.path.join("."))
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Missing required env var: ${missing}. See .env.example for the complete list of required variables.`,
    );
  }

  // Parse optional env vars with defaults — never throws
  const optionalResult = OptionalEnvSchema.parse(process.env);

  _config = {
    // Required
    telegramBotToken: requiredResult.data.TELEGRAM_BOT_TOKEN,
    telegramUserId: requiredResult.data.TELEGRAM_USER_ID,
    supabaseUrl: requiredResult.data.SUPABASE_URL,
    supabaseAnonKey: requiredResult.data.SUPABASE_ANON_KEY,

    // Optional
    userName: optionalResult.USER_NAME,
    userTimezone: optionalResult.USER_TIMEZONE,
    telegramGroupId: optionalResult.TELEGRAM_GROUP_ID,
    sprintThreadId: optionalResult.SPRINT_THREAD_ID,
    devThreadId: optionalResult.DEV_THREAD_ID,
    ideasThreadId: optionalResult.IDEAS_THREAD_ID,
    serverThreadId: optionalResult.SERVER_THREAD_ID,
    claudePath: optionalResult.CLAUDE_PATH,
    projectDir: optionalResult.PROJECT_DIR,
    relayDir: optionalResult.RELAY_DIR,
    voiceProvider: optionalResult.VOICE_PROVIDER,
    groqApiKey: optionalResult.GROQ_API_KEY,
    groqTtsVoice: optionalResult.GROQ_TTS_VOICE,
    groqTtsModel: optionalResult.GROQ_TTS_MODEL,
    ttsProvider: optionalResult.TTS_PROVIDER,
    piperBinary: optionalResult.PIPER_BINARY,
    piperModelPath: optionalResult.PIPER_MODEL_PATH,
    whisperBinary: optionalResult.WHISPER_BINARY,
    whisperModelPath: optionalResult.WHISPER_MODEL_PATH,
    whisperLanguage: optionalResult.WHISPER_LANGUAGE,
    githubRepo: optionalResult.GITHUB_REPO,
    githubProjectNumber: optionalResult.GITHUB_PROJECT_NUMBER,
    nodeEnv: optionalResult.NODE_ENV,
    logLevel: optionalResult.LOG_LEVEL,
    heartbeatDebug: optionalResult.HEARTBEAT_DEBUG,
    tmpDir: optionalResult.TMPDIR,
    maturationDir: optionalResult.MATURATION_DIR,
  };

  return _config;
}

/**
 * Resets the config singleton.
 * FOR TESTING ONLY — allows tests to reinitialize with different process.env values.
 */
export function _resetConfigForTesting(): void {
  _config = null;
}
