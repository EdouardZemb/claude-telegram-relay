import { describe, it, expect } from "bun:test";
import {
  getMcpToolsForRole,
  getMcpAllowedToolNames,
  buildMcpToolInstructions,
  isToolAllowed,
  MCP_TOOLS,
} from "../../src/mcp-config.ts";

describe("mcp-config", () => {
  describe("getMcpToolsForRole", () => {
    it("returns tools for analyst role (no write, no blackboard write)", () => {
      const tools = getMcpToolsForRole("analyst");
      expect(tools).toContain("search_thoughts");
      expect(tools).toContain("get_project_context");
      expect(tools).not.toContain("capture_thought");
      expect(tools).not.toContain("write_blackboard");
    });

    it("returns tools for pm role (can capture, no blackboard write)", () => {
      const tools = getMcpToolsForRole("pm");
      expect(tools).toContain("capture_thought");
      expect(tools).toContain("get_tasks");
      expect(tools).not.toContain("write_blackboard");
    });

    it("returns all tools for architect role", () => {
      const tools = getMcpToolsForRole("architect");
      expect(tools).toContain("read_blackboard");
      expect(tools).toContain("write_blackboard");
      expect(tools).toContain("search_thoughts");
      expect(tools.length).toBe(MCP_TOOLS.length);
    });

    it("returns all tools for dev role", () => {
      const tools = getMcpToolsForRole("dev");
      expect(tools).toContain("read_blackboard");
      expect(tools).toContain("write_blackboard");
      expect(tools.length).toBe(MCP_TOOLS.length);
    });

    it("returns read-only tools for qa role", () => {
      const tools = getMcpToolsForRole("qa");
      expect(tools).toContain("read_blackboard");
      expect(tools).toContain("search_thoughts");
      expect(tools).not.toContain("write_blackboard");
      expect(tools).not.toContain("capture_thought");
    });

    it("returns memory-only tools for sm role", () => {
      const tools = getMcpToolsForRole("sm");
      expect(tools).toContain("search_thoughts");
      expect(tools).toContain("capture_thought");
      expect(tools).not.toContain("get_tasks");
      expect(tools).not.toContain("read_blackboard");
      expect(tools.length).toBe(4);
    });

    it("falls back to dev tools for unknown role", () => {
      const tools = getMcpToolsForRole("unknown");
      const devTools = getMcpToolsForRole("dev");
      expect(tools).toEqual(devTools);
    });
  });

  describe("getMcpAllowedToolNames", () => {
    it("formats tool names with mcp__memory__ prefix", () => {
      const names = getMcpAllowedToolNames("sm");
      expect(names).toContain("mcp__memory__search_thoughts");
      expect(names).toContain("mcp__memory__capture_thought");
      expect(names.every((n) => n.startsWith("mcp__memory__"))).toBe(true);
    });

    it("returns correct count matching role tools", () => {
      const tools = getMcpToolsForRole("qa");
      const names = getMcpAllowedToolNames("qa");
      expect(names.length).toBe(tools.length);
    });
  });

  describe("buildMcpToolInstructions", () => {
    it("includes header and tool list", () => {
      const instructions = buildMcpToolInstructions("dev");
      expect(instructions).toContain("OUTILS MCP DISPONIBLES");
      expect(instructions).toContain("search_thoughts");
      expect(instructions).toContain("write_blackboard");
    });

    it("includes role-specific guidance", () => {
      const devInstructions = buildMcpToolInstructions("dev");
      expect(devInstructions).toContain("read_blackboard pour lire le plan");

      const qaInstructions = buildMcpToolInstructions("qa");
      expect(qaInstructions).toContain("Ne modifie pas le blackboard");
    });

    it("only lists tools allowed for the role", () => {
      const smInstructions = buildMcpToolInstructions("sm");
      expect(smInstructions).toContain("search_thoughts");
      expect(smInstructions).not.toContain("- get_tasks:");
      expect(smInstructions).not.toContain("- read_blackboard:");
    });
  });

  describe("isToolAllowed", () => {
    it("returns true for allowed tools", () => {
      expect(isToolAllowed("dev", "write_blackboard")).toBe(true);
      expect(isToolAllowed("analyst", "search_thoughts")).toBe(true);
    });

    it("returns false for disallowed tools", () => {
      expect(isToolAllowed("analyst", "write_blackboard")).toBe(false);
      expect(isToolAllowed("sm", "get_tasks")).toBe(false);
      expect(isToolAllowed("qa", "capture_thought")).toBe(false);
    });
  });
});
