import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { buildMcpToolInstructions, getMcpToolsForRole } from "../../src/mcp-config.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

describe("MCP blackboard integration", () => {
  describe("MCP server exposes blackboard tools", () => {
    it("memory-server.ts registers read_blackboard tool", () => {
      const content = readFileSync(join(PROJECT_ROOT, "mcp/memory-server.ts"), "utf-8");
      expect(content).toContain('"read_blackboard"');
      expect(content).toContain("session_id");
      expect(content).toContain("section");
    });

    it("memory-server.ts registers write_blackboard tool", () => {
      const content = readFileSync(join(PROJECT_ROOT, "mcp/memory-server.ts"), "utf-8");
      expect(content).toContain('"write_blackboard"');
      expect(content).toContain("session_id");
      expect(content).toContain("data");
      expect(content).toContain("role");
    });

    it("write_blackboard uses optimistic locking (version check)", () => {
      const content = readFileSync(join(PROJECT_ROOT, "mcp/memory-server.ts"), "utf-8");
      expect(content).toContain("version=eq.");
      expect(content).toContain("version conflict");
    });
  });

  describe("MCP config allows blackboard access per role", () => {
    it("dev and architect can read and write blackboard", () => {
      const devTools = getMcpToolsForRole("dev");
      const archTools = getMcpToolsForRole("architect");
      expect(devTools).toContain("read_blackboard");
      expect(devTools).toContain("write_blackboard");
      expect(archTools).toContain("read_blackboard");
      expect(archTools).toContain("write_blackboard");
    });

    it("qa can read but not write blackboard", () => {
      const qaTools = getMcpToolsForRole("qa");
      expect(qaTools).toContain("read_blackboard");
      expect(qaTools).not.toContain("write_blackboard");
    });

    it("analyst and sm cannot access blackboard", () => {
      const analystTools = getMcpToolsForRole("analyst");
      const smTools = getMcpToolsForRole("sm");
      expect(analystTools).not.toContain("read_blackboard");
      expect(analystTools).not.toContain("write_blackboard");
      expect(smTools).not.toContain("read_blackboard");
      expect(smTools).not.toContain("write_blackboard");
    });
  });

  describe("MCP tool instructions for blackboard", () => {
    it("dev instructions mention reading plan before coding", () => {
      const instructions = buildMcpToolInstructions("dev");
      expect(instructions).toContain("read_blackboard");
      expect(instructions).toContain("write_blackboard");
      expect(instructions).toContain("plan");
    });

    it("qa instructions mention comparing with specs", () => {
      const instructions = buildMcpToolInstructions("qa");
      expect(instructions).toContain("read_blackboard");
      expect(instructions).not.toContain("- write_blackboard:");
    });
  });

  describe(".mcp.json configuration", () => {
    it("project .mcp.json configures memory server", () => {
      const config = JSON.parse(readFileSync(join(PROJECT_ROOT, ".mcp.json"), "utf-8"));
      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers.memory).toBeDefined();
      expect(config.mcpServers.memory.type).toBe("stdio");
      expect(config.mcpServers.memory.command).toBe("bun");
    });
  });

  describe("spawnClaude integrates mcpRole", () => {
    it("agent.ts imports buildMcpToolInstructions", () => {
      const content = readFileSync(join(PROJECT_ROOT, "src/agent.ts"), "utf-8");
      expect(content).toContain("buildMcpToolInstructions");
      expect(content).toContain("mcpRole");
    });

    it("orchestrator.ts passes mcpRole to spawnClaude", () => {
      const content = readFileSync(join(PROJECT_ROOT, "src/orchestrator.ts"), "utf-8");
      expect(content).toContain("mcpRole: agentId");
    });
  });
});
