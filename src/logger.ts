// Structured logger with JSON (production) and human-readable (dev) output
// Correlation ID propagation via AsyncLocalStorage

import { AsyncLocalStorage } from "node:async_hooks";

// --- Types ---

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  correlation_id: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface LogOptions {
  module?: string;
  [key: string]: unknown;
}

export interface CorrelationContext {
  chat_id?: number | string;
  message_id?: number | string;
}

// --- Correlation ID storage ---

const correlationStore = new AsyncLocalStorage<string>();

/** Build correlation ID from chat_id and message_id */
function buildCorrelationId(ctx: CorrelationContext): string {
  const parts: string[] = [];
  if (ctx.chat_id != null) parts.push(String(ctx.chat_id));
  if (ctx.message_id != null) parts.push(String(ctx.message_id));
  return parts.join(":") || "unknown";
}

/** Run a callback with a correlation ID derived from chat_id + message_id */
export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
  const id = buildCorrelationId(ctx);
  return correlationStore.run(id, fn);
}

/** Get the current correlation ID (or null if none set) */
export function getCorrelationId(): string | null {
  return correlationStore.getStore() ?? null;
}

// --- Environment detection ---

const isProduction = process.env.NODE_ENV === "production";

// --- Log level filtering ---

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return isProduction ? "info" : "debug";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[getMinLevel()];
}

// --- Formatters ---

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function formatJson(entry: LogEntry): string {
  const obj: Record<string, unknown> = {
    timestamp: entry.timestamp,
    level: entry.level,
    module: entry.module,
    correlation_id: entry.correlation_id,
    message: entry.message,
  };
  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    obj.metadata = entry.metadata;
  }
  return JSON.stringify(obj);
}

function formatDev(entry: LogEntry): string {
  const color = COLORS[entry.level];
  const time = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
  const lvl = entry.level.toUpperCase().padEnd(5);
  const mod = entry.module ? `${DIM}[${entry.module}]${RESET}` : "";
  const cid = entry.correlation_id ? ` ${DIM}cid=${entry.correlation_id}${RESET}` : "";
  const meta =
    entry.metadata && Object.keys(entry.metadata).length > 0
      ? ` ${DIM}${JSON.stringify(entry.metadata)}${RESET}`
      : "";
  return `${DIM}${time}${RESET} ${color}${lvl}${RESET} ${mod}${cid} ${entry.message}${meta}`;
}

// --- Core log function ---

function log(level: LogLevel, message: string, options?: LogOptions): void {
  if (!shouldLog(level)) return;

  const { module: mod, ...rest } = options ?? {};

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module: mod ?? "app",
    correlation_id: getCorrelationId(),
    message,
    metadata: Object.keys(rest).length > 0 ? rest : undefined,
  };

  const formatted = isProduction ? formatJson(entry) : formatDev(entry);

  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

// --- Public API ---

/** Create a child logger bound to a specific module name */
export function createLogger(moduleName: string) {
  return {
    debug: (message: string, opts?: Omit<LogOptions, "module">) =>
      log("debug", message, { ...opts, module: moduleName }),
    info: (message: string, opts?: Omit<LogOptions, "module">) =>
      log("info", message, { ...opts, module: moduleName }),
    warn: (message: string, opts?: Omit<LogOptions, "module">) =>
      log("warn", message, { ...opts, module: moduleName }),
    error: (message: string, opts?: Omit<LogOptions, "module">) =>
      log("error", message, { ...opts, module: moduleName }),
  };
}

// Default logger instance
const logger = {
  debug: (message: string, opts?: LogOptions) => log("debug", message, opts),
  info: (message: string, opts?: LogOptions) => log("info", message, opts),
  warn: (message: string, opts?: LogOptions) => log("warn", message, opts),
  error: (message: string, opts?: LogOptions) => log("error", message, opts),
};

export default logger;
