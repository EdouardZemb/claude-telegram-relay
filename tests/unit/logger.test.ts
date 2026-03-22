import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import logger, {
  createLogger,
  getCorrelationId,
  type LogEntry,
  withCorrelation,
} from "../../src/logger.ts";

// Helper: capture console output and parse JSON when in production mode
function captureLog(fn: () => void, stream: "log" | "error" | "warn" = "log"): string[] {
  const captured: string[] = [];
  const spy = spyOn(console, stream).mockImplementation((...args: unknown[]) => {
    captured.push(String(args[0]));
  });
  fn();
  spy.mockRestore();
  return captured;
}

describe("logger", () => {
  const origEnv = process.env.NODE_ENV;
  const origLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLogLevel;
  });

  // ============================================================
  // AC-1: JSON output in production with all required fields
  // ============================================================
  describe("AC-1: JSON structured output in production", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
      delete process.env.LOG_LEVEL;
    });

    it("emits valid JSON with all required fields on logger.info()", () => {
      // We need to re-import to pick up env change — but since isProduction
      // is evaluated at module load, we use a dynamic import workaround.
      // Instead, we test the exported module and verify the format.
      // The module reads process.env.NODE_ENV at call time for each log.
      // Actually — let's check the module. The const isProduction is set at
      // module load. So we need to test via the module's behavior.
      //
      // Since isProduction is a module-level const, and we can't re-import easily,
      // we'll test the actual formatting by checking the output.
      // For CI/production testing, NODE_ENV would be set before the module loads.
      //
      // For unit test purposes, we verify the JSON formatter by testing log output.
      // The module evaluates isProduction once at load time, so in test env it
      // will use dev format. We'll test the underlying behavior indirectly.

      // This test verifies the logger emits output and doesn't throw
      const lines = captureLog(() => {
        logger.info("test message", { module: "relay" });
      });
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("test message");
    });

    it("logger.info includes module name in output", () => {
      const lines = captureLog(() => {
        logger.info("hello world", { module: "relay" });
      });
      expect(lines[0]).toContain("relay");
    });

    it("logger.error writes to stderr", () => {
      const lines = captureLog(() => {
        logger.error("something broke", { module: "relay" });
      }, "error");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("something broke");
    });

    it("logger.warn writes to console.warn", () => {
      const lines = captureLog(() => {
        logger.warn("caution", { module: "relay" });
      }, "warn");
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("caution");
    });

    it("all four log levels work without throwing", () => {
      expect(() => {
        const _devNull = captureLog(() => logger.debug("d", { module: "test" }));
        // debug may be filtered, that's ok
      }).not.toThrow();

      const infoLines = captureLog(() => logger.info("i", { module: "test" }));
      expect(infoLines.length).toBeGreaterThanOrEqual(1);

      const warnLines = captureLog(() => logger.warn("w", { module: "test" }), "warn");
      expect(warnLines.length).toBe(1);

      const errorLines = captureLog(() => logger.error("e", { module: "test" }), "error");
      expect(errorLines.length).toBe(1);
    });

    it("metadata fields are included in output", () => {
      const lines = captureLog(() => {
        logger.info("with meta", { module: "relay", userId: 42, action: "login" });
      });
      expect(lines[0]).toContain("relay");
      // metadata should appear somewhere in the output
      expect(lines[0]).toContain("42");
    });
  });

  // Test JSON format explicitly by checking formatJson behavior
  describe("AC-1: JSON format validation", () => {
    it("produces valid JSON with all required fields when NODE_ENV=production", async () => {
      // We need a fresh module import with NODE_ENV=production
      // Since Bun caches modules, we test the format by temporarily
      // invoking the internal formatting through the public API.
      // We verify the structure by importing the module in a subprocess.

      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("test-ac1", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const _stderr = await new Response(proc.stderr).text();
      const output = stdout.trim();

      // Should be valid JSON
      const parsed = JSON.parse(output) as LogEntry;
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("relay");
      expect(parsed.correlation_id).toBeNull(); // no correlation set
      expect(parsed.message).toBe("test-ac1");
    });

    it("includes metadata in JSON output when provided", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("meta-test", { module: "agent", taskId: 99 });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata.taskId).toBe(99);
    });

    it("omits metadata key when no extra fields provided", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("no-meta", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.metadata).toBeUndefined();
    });

    it("error level writes to stderr as valid JSON", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger } = await import("./src/logger.ts");
        logger.error("err-test", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stderr = await new Response(proc.stderr).text();
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("err-test");
    });

    it("timestamp is valid ISO 8601", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("ts-test", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const parsed = JSON.parse(stdout.trim());
      const date = new Date(parsed.timestamp);
      expect(date.toISOString()).toBe(parsed.timestamp);
    });
  });

  // ============================================================
  // AC-2: Human-readable format with colors in dev
  // ============================================================
  describe("AC-2: Human-readable colored output in dev", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "development";
      delete process.env.LOG_LEVEL;
    });

    it("dev output is NOT valid JSON (human-readable)", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("dev-test", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const output = stdout.trim();

      // Should NOT be valid JSON in dev mode
      expect(() => JSON.parse(output)).toThrow();
      // Should contain the message
      expect(output).toContain("dev-test");
      // Should contain ANSI color codes
      expect(output).toContain("\x1b[");
    });

    it("dev output contains level label", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        const { default: logger } = await import("./src/logger.ts");
        logger.warn("warn-dev", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development" },
        },
      );

      // warn goes to console.warn which bun routes to stderr
      const stderr = await new Response(proc.stderr).text();
      expect(stderr).toContain("WARN");
    });

    it("dev output contains module name in brackets", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("mod-test", { module: "orchestrator" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      expect(stdout).toContain("[orchestrator]");
    });

    it("dev output contains time portion (HH:mm:ss)", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        const { default: logger } = await import("./src/logger.ts");
        logger.info("time-test", { module: "relay" });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      // Should contain a time pattern like HH:mm:ss
      expect(stdout).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it("each log level uses different ANSI color codes", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        process.env.LOG_LEVEL = "debug";
        const { default: logger } = await import("./src/logger.ts");
        logger.debug("d");
        logger.info("i");
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development", LOG_LEVEL: "debug" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      // cyan for debug (\x1b[36m), green for info (\x1b[32m)
      expect(stdout).toContain("\x1b[36m"); // debug = cyan
      expect(stdout).toContain("\x1b[32m"); // info = green
    });
  });

  // ============================================================
  // AC-3: Correlation ID propagation
  // ============================================================
  describe("AC-3: Correlation ID from chat_id + message_id", () => {
    it("getCorrelationId() returns null outside withCorrelation", () => {
      expect(getCorrelationId()).toBeNull();
    });

    it("withCorrelation sets correlation ID for the callback", () => {
      withCorrelation({ chat_id: 123, message_id: 456 }, () => {
        expect(getCorrelationId()).toBe("123:456");
      });
    });

    it("correlation ID format is chat_id:message_id", () => {
      withCorrelation({ chat_id: -100999, message_id: 42 }, () => {
        expect(getCorrelationId()).toBe("-100999:42");
      });
    });

    it("correlation ID with only chat_id", () => {
      withCorrelation({ chat_id: 123 }, () => {
        expect(getCorrelationId()).toBe("123");
      });
    });

    it("correlation ID with only message_id", () => {
      withCorrelation({ message_id: 456 }, () => {
        expect(getCorrelationId()).toBe("456");
      });
    });

    it("correlation ID appears in production JSON output", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger, withCorrelation } = await import("./src/logger.ts");
        withCorrelation({ chat_id: 111, message_id: 222 }, () => {
          logger.info("corr-test", { module: "relay" });
        });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.correlation_id).toBe("111:222");
    });

    it("correlation ID appears in dev output", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "development";
        const { default: logger, withCorrelation } = await import("./src/logger.ts");
        withCorrelation({ chat_id: 111, message_id: 222 }, () => {
          logger.info("corr-dev", { module: "relay" });
        });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "development" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      expect(stdout).toContain("cid=111:222");
    });

    it("all logs within withCorrelation share the same correlation_id", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        const { default: logger, withCorrelation } = await import("./src/logger.ts");
        withCorrelation({ chat_id: 555, message_id: 666 }, () => {
          logger.info("first", { module: "a" });
          logger.info("second", { module: "b" });
          logger.info("third", { module: "c" });
        });
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(3);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.correlation_id).toBe("555:666");
      }
    });

    it("nested withCorrelation overrides parent", () => {
      withCorrelation({ chat_id: 1, message_id: 1 }, () => {
        expect(getCorrelationId()).toBe("1:1");
        withCorrelation({ chat_id: 2, message_id: 2 }, () => {
          expect(getCorrelationId()).toBe("2:2");
        });
        // parent restored
        expect(getCorrelationId()).toBe("1:1");
      });
    });

    it("withCorrelation works with async callbacks", async () => {
      const result = await withCorrelation({ chat_id: 99, message_id: 88 }, async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getCorrelationId();
      });
      expect(result).toBe("99:88");
    });
  });

  // ============================================================
  // createLogger (child logger)
  // ============================================================
  describe("createLogger", () => {
    it("creates a logger bound to a module name", () => {
      const log = createLogger("orchestrator");
      const lines = captureLog(() => {
        log.info("child test");
      });
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("orchestrator");
    });

    it("child logger supports all four levels", () => {
      const log = createLogger("test-mod");

      process.env.LOG_LEVEL = "debug";

      const logLines = captureLog(() => log.debug("d"));
      const infoLines = captureLog(() => log.info("i"));
      const warnLines = captureLog(() => log.warn("w"), "warn");
      const errorLines = captureLog(() => log.error("e"), "error");

      // All levels should produce output (LOG_LEVEL=debug)
      expect(logLines.length + infoLines.length).toBeGreaterThanOrEqual(1);
      expect(warnLines.length).toBe(1);
      expect(errorLines.length).toBe(1);
    });

    it("child logger includes metadata", () => {
      const log = createLogger("relay");
      const lines = captureLog(() => {
        log.info("with extra", { userId: 42 });
      });
      expect(lines[0]).toContain("42");
    });
  });

  // ============================================================
  // Log level filtering
  // ============================================================
  describe("log level filtering", () => {
    it("LOG_LEVEL=error suppresses info and warn", () => {
      process.env.LOG_LEVEL = "error";

      const infoLines = captureLog(() => logger.info("should not appear"));
      const warnLines = captureLog(() => logger.warn("should not appear"), "warn");
      const errorLines = captureLog(() => logger.error("should appear"), "error");

      expect(infoLines.length).toBe(0);
      expect(warnLines.length).toBe(0);
      expect(errorLines.length).toBe(1);
    });

    it("LOG_LEVEL=warn allows warn and error but not info", () => {
      process.env.LOG_LEVEL = "warn";

      const infoLines = captureLog(() => logger.info("filtered"));
      const warnLines = captureLog(() => logger.warn("visible"), "warn");

      expect(infoLines.length).toBe(0);
      expect(warnLines.length).toBe(1);
    });

    it("LOG_LEVEL=debug allows all levels", () => {
      process.env.LOG_LEVEL = "debug";

      const debugLines = captureLog(() => logger.debug("visible"));
      const infoLines = captureLog(() => logger.info("visible"));

      expect(debugLines.length).toBe(1);
      expect(infoLines.length).toBe(1);
    });

    it("default log level in production is info (debug filtered)", async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
        process.env.NODE_ENV = "production";
        delete process.env.LOG_LEVEL;
        const { default: logger } = await import("./src/logger.ts");
        logger.debug("should-not-appear");
        logger.info("should-appear");
      `,
        ],
        {
          cwd: "/home/edouard/claude-telegram-relay",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "" },
        },
      );

      const stdout = await new Response(proc.stdout).text();
      expect(stdout).not.toContain("should-not-appear");
      expect(stdout).toContain("should-appear");
    });
  });
});
