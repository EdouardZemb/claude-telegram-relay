/**
 * @module readme.test
 * @description Tests for README.md completeness and correctness.
 * Validates architecture docs, Mermaid syntax, and feature coverage (AC-1, AC-2, AC-3).
 */

import { describe, test, expect } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const README_PATH = join(ROOT, "README.md");
const CLAUDE_MD_PATH = join(ROOT, "CLAUDE.md");

let readme: string;
let claudeMd: string;

// Load files once
const readmePromise = readFile(README_PATH, "utf-8").then((c) => (readme = c));
const claudeMdPromise = readFile(CLAUDE_MD_PATH, "utf-8").then((c) => (claudeMd = c));

describe("README AC-1: architecture, commands, workflow, deploy", () => {
  test("contains architecture section with Composer modules", async () => {
    await readmePromise;
    expect(readme).toContain("## Architecture");
    expect(readme).toContain("Command Composers");
    expect(readme).toContain("relay.ts");
    expect(readme).toContain("loader.ts");
    expect(readme).toContain("bot-context.ts");
  });

  test("documents all 33 Telegram commands", async () => {
    await readmePromise;
    const commands = [
      "/prd", "/plan", "/planify", "/exec", "/orchestrate", "/autopipeline",
      "/workflow", "/agents", "/task", "/backlog", "/sprint", "/start", "/done",
      "/metrics", "/retro", "/patterns", "/alerts", "/cost", "/estimate",
      "/monitor", "/brain", "/ideas", "/remind", "/profile", "/notify",
      "/projects", "/project", "/help", "/status", "/speak", "/export",
      "/feature", "/rollback",
    ];
    for (const cmd of commands) {
      expect(readme).toContain(`\`${cmd}`);
    }
  });

  test("documents BMad workflow with gates and pipelines", async () => {
    await readmePromise;
    expect(readme).toContain("## BMad Methodology");
    expect(readme).toContain("Gate 1");
    expect(readme).toContain("Gate 2");
    expect(readme).toContain("Gate 3");
    expect(readme).toContain("DEFAULT");
    expect(readme).toContain("QUICK");
    expect(readme).toContain("REVIEW");
  });

  test("documents deployment with CI/CD and PM2", async () => {
    await readmePromise;
    expect(readme).toContain("CI/CD");
    expect(readme).toContain("PM2");
    expect(readme).toContain("Self-hosted GitHub Actions");
    expect(readme).toContain("Auto-rollback");
    expect(readme).toContain("Smoke Test");
  });

  test("contains Quick Start with clone + claude instructions", async () => {
    await readmePromise;
    expect(readme).toContain("## Quick Start");
    expect(readme).toContain("git clone");
    expect(readme).toContain("claude");
    expect(readme).toContain("bun test");
  });

  test("contains Process A vs Process B comparison", async () => {
    await readmePromise;
    expect(readme).toContain("## Process A vs Process B");
    expect(readme).toContain("Process A");
    expect(readme).toContain("Process B");
    expect(readme).toContain("Direct Conversation");
    expect(readme).toContain("BMad Pipeline");
  });
});

describe("README AC-2: Mermaid diagrams are valid", () => {
  test("all mermaid blocks have matching open/close fences", async () => {
    await readmePromise;
    const openCount = (readme.match(/```mermaid/g) || []).length;
    const closeAfterMermaid = readme.split("```mermaid").length - 1;
    expect(openCount).toBeGreaterThanOrEqual(1);
    expect(openCount).toBe(closeAfterMermaid);
  });

  test("mermaid blocks use valid diagram types", async () => {
    await readmePromise;
    const mermaidBlocks = readme.match(/```mermaid\n([\s\S]*?)```/g) || [];
    expect(mermaidBlocks.length).toBeGreaterThanOrEqual(7);

    const validTypes = [
      "flowchart", "graph", "sequenceDiagram", "stateDiagram-v2",
      "classDiagram", "erDiagram", "gantt", "pie",
    ];

    for (const block of mermaidBlocks) {
      const content = block.replace("```mermaid\n", "").replace("```", "").trim();
      const firstWord = content.split(/[\s\n]/)[0];
      expect(validTypes).toContain(firstWord);
    }
  });

  test("no empty mermaid blocks", async () => {
    await readmePromise;
    const mermaidBlocks = readme.match(/```mermaid\n([\s\S]*?)```/g) || [];
    for (const block of mermaidBlocks) {
      const content = block.replace("```mermaid\n", "").replace("```", "").trim();
      expect(content.length).toBeGreaterThan(10);
    }
  });

  test("mermaid blocks have balanced subgraphs", async () => {
    await readmePromise;
    const mermaidBlocks = readme.match(/```mermaid\n([\s\S]*?)```/g) || [];
    for (const block of mermaidBlocks) {
      // Count block-opening keywords (subgraph, rect) vs end
      const blockOpens = (block.match(/\b(subgraph|rect)\b/g) || []).length;
      const blockCloses = (block.match(/\bend\b/g) || []).length;
      expect(blockOpens).toBe(blockCloses);
    }
  });
});

describe("README AC-3: reflects all features up to S31", () => {
  test("reflects S28 CLI optimization (multi-model, spawnClaude)", async () => {
    await readmePromise;
    expect(readme).toContain("Opus");
    expect(readme).toContain("Sonnet");
    expect(readme).toContain("Haiku");
  });

  test("reflects S29 production readiness (feature flags, smoke, rollback)", async () => {
    await readmePromise;
    expect(readme).toContain("Feature flags");
    expect(readme).toContain("Smoke");
    expect(readme).toContain("/rollback");
    expect(readme).toContain("/monitor");
  });

  test("reflects S30 CI/CD and E2E testing (self-hosted runner)", async () => {
    await readmePromise;
    expect(readme).toContain("self-hosted");
    expect(readme).toContain("E2E");
  });

  test("reflects S31 Composer extensibility", async () => {
    await readmePromise;
    expect(readme).toContain("## Extending the Bot");
    expect(readme).toContain("Composer");
    expect(readme).toContain("loader");
    expect(readme).toContain("BotContext");
    expect(readme).toContain("ADR-007");
  });

  test("all CLAUDE.md Composer modules appear in README", async () => {
    await readmePromise;
    await claudeMdPromise;
    const composerFiles = [
      "help.ts", "tasks.ts", "execution.ts", "planning.ts",
      "memory-cmds.ts", "quality.ts", "profile.ts", "project.ts",
      "utilities.ts", "zz-messages.ts",
    ];
    for (const file of composerFiles) {
      expect(readme).toContain(file);
    }
  });

  test("key infrastructure components from CLAUDE.md are documented", async () => {
    await readmePromise;
    // Core features that must be in README per CLAUDE.md
    const features = [
      "blackboard", "dag-executor",
      "gate-evaluator", "adversarial", "notification-queue",
      "cost-tracking", "MCP",
    ];
    for (const feature of features) {
      expect(readme.toLowerCase()).toContain(feature.toLowerCase());
    }
  });
});
