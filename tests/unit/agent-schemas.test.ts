/**
 * Tests for Structured Agent Message Schemas — S22-01/02
 */
import { describe, expect, it } from "bun:test";
import {
  type AgentMessage,
  type AnalystOutput,
  type ArchitectOutput,
  buildStructuredChainContext,
  buildStructuredOutputInstructions,
  type DevOutput,
  type ExplorationPhaseOutput,
  formatExplorationPhaseOutput,
  getJsonSchemaForRole,
  getSchemaForRole,
  type PmOutput,
  parseAgentOutput,
  parseExplorationPhaseOutput,
  type QaOutput,
  type SmOutput,
  validateAgentOutput,
  validateExplorationPhaseOutput,
} from "../../src/agent-schemas.ts";

// ── Schema Descriptions ──────────────────────────────────────

describe("getSchemaForRole", () => {
  it("returns schema for all 6 roles", () => {
    const roles = ["analyst", "pm", "architect", "dev", "qa", "sm"] as const;
    for (const role of roles) {
      const schema = getSchemaForRole(role);
      expect(schema.length).toBeGreaterThan(50);
      expect(schema).toContain(`"role": "${role}"`);
    }
  });

  it("returns empty string for unknown role", () => {
    expect(getSchemaForRole("unknown" as any)).toBe("");
  });
});

// ── buildStructuredOutputInstructions ────────────────────────

describe("buildStructuredOutputInstructions", () => {
  it("includes JSON markers instructions", () => {
    const instructions = buildStructuredOutputInstructions("analyst");
    expect(instructions).toContain("<<<JSON>>>");
    expect(instructions).toContain("<<<END>>>");
    expect(instructions).toContain("FORMAT DE SORTIE OBLIGATOIRE");
  });

  it("includes the schema for the role", () => {
    const instructions = buildStructuredOutputInstructions("qa");
    expect(instructions).toContain('"score"');
    expect(instructions).toContain('"findings"');
  });

  it("returns empty for unknown role", () => {
    expect(buildStructuredOutputInstructions("unknown" as any)).toBe("");
  });
});

// ── Validation ───────────────────────────────────────────────

describe("validateAgentOutput", () => {
  it("validates analyst output", () => {
    expect(
      validateAgentOutput(
        {
          analysis: "test",
          risks: [{ severity: "high", description: "risk" }],
          recommendations: ["rec1"],
          dependencies: [],
          feasibility: "high",
        },
        "analyst",
      ),
    ).toBe(true);
  });

  it("rejects analyst without required fields", () => {
    expect(validateAgentOutput({ analysis: "test" }, "analyst")).toBe(false);
    expect(validateAgentOutput({ risks: [] }, "analyst")).toBe(false);
  });

  it("validates pm output", () => {
    expect(
      validateAgentOutput(
        {
          subtasks: [{ title: "t1", description: "d", priority: 1, acceptance_criteria: "ac" }],
          priorities: ["p1"],
          risks: [],
        },
        "pm",
      ),
    ).toBe(true);
  });

  it("rejects pm without subtasks", () => {
    expect(validateAgentOutput({ priorities: [] }, "pm")).toBe(false);
  });

  it("validates architect output", () => {
    expect(
      validateAgentOutput(
        {
          design: "microservices",
          components: [],
          files_impacted: ["src/a.ts"],
          patterns: [],
          technical_risks: [],
          decisions: [],
        },
        "architect",
      ),
    ).toBe(true);
  });

  it("rejects architect without design", () => {
    expect(validateAgentOutput({ files_impacted: ["a.ts"] }, "architect")).toBe(false);
  });

  it("validates dev output", () => {
    expect(
      validateAgentOutput(
        {
          files_modified: ["src/x.ts"],
          tests_added: [],
          summary: "done",
          issues_encountered: [],
        },
        "dev",
      ),
    ).toBe(true);
  });

  it("rejects dev without summary", () => {
    expect(validateAgentOutput({ files_modified: [] }, "dev")).toBe(false);
  });

  it("validates qa output", () => {
    expect(
      validateAgentOutput(
        {
          score: 85,
          findings: [{ severity: "minor", description: "d", suggestion: "s" }],
          summary: "all good",
          tests_missing: [],
        },
        "qa",
      ),
    ).toBe(true);
  });

  it("rejects qa without score", () => {
    expect(validateAgentOutput({ findings: [], summary: "ok", tests_missing: [] }, "qa")).toBe(
      false,
    );
  });

  it("validates sm output", () => {
    expect(
      validateAgentOutput(
        {
          summary: "sprint ok",
          blockers: [],
          next_steps: ["deploy"],
          follow_ups: [],
        },
        "sm",
      ),
    ).toBe(true);
  });

  it("rejects sm without next_steps", () => {
    expect(validateAgentOutput({ summary: "ok" }, "sm")).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(validateAgentOutput(null, "analyst")).toBe(false);
    expect(validateAgentOutput("string", "analyst")).toBe(false);
    expect(validateAgentOutput(42, "pm")).toBe(false);
  });

  it("rejects unknown role", () => {
    expect(validateAgentOutput({ summary: "x" }, "unknown" as any)).toBe(false);
  });
});

// ── Parsing ──────────────────────────────────────────────────

describe("parseAgentOutput", () => {
  it("parses marked JSON with <<<JSON>>> markers", () => {
    const raw = `Voici mon analyse.

<<<JSON>>>
{
  "analysis": "Le systeme est faisable",
  "risks": [{"severity": "low", "description": "mineur"}],
  "recommendations": ["commencer par un POC"],
  "dependencies": ["supabase"],
  "feasibility": "high"
}
<<<END>>>

Voila.`;

    const result = parseAgentOutput(raw, "analyst");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("analyst");
    expect((result as AnalystOutput).analysis).toBe("Le systeme est faisable");
    expect((result as AnalystOutput).feasibility).toBe("high");
  });

  it("falls back to finding JSON object in text", () => {
    const raw = `J'ai fini l'implementation. Voici le resume:
{
  "files_modified": ["src/relay.ts", "src/agent.ts"],
  "tests_added": ["tests/unit/relay.test.ts"],
  "summary": "Ajout de la commande /ideas",
  "issues_encountered": []
}
Fin.`;

    const result = parseAgentOutput(raw, "dev");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("dev");
    expect((result as DevOutput).files_modified).toContain("src/relay.ts");
  });

  it("returns null when no valid JSON found", () => {
    const raw = "Juste du texte libre sans JSON.";
    expect(parseAgentOutput(raw, "analyst")).toBeNull();
  });

  it("returns null when JSON doesn't match schema", () => {
    const raw = `<<<JSON>>>
{"name": "irrelevant", "value": 42}
<<<END>>>`;
    expect(parseAgentOutput(raw, "qa")).toBeNull();
  });

  it("picks the largest JSON object as fallback", () => {
    const raw = `Small: {"a": 1}
Big: {
  "score": 92,
  "findings": [],
  "summary": "Excellent",
  "tests_missing": ["edge case test"]
}`;

    const result = parseAgentOutput(raw, "qa");
    expect(result).not.toBeNull();
    expect((result as QaOutput).score).toBe(92);
  });

  it("handles malformed JSON gracefully", () => {
    const raw = `<<<JSON>>>
{invalid json here}
<<<END>>>`;
    expect(parseAgentOutput(raw, "analyst")).toBeNull();
  });

  it("parses PM output with subtasks", () => {
    const raw = `<<<JSON>>>
{
  "subtasks": [
    {"title": "Creer le schema", "description": "Table SQL", "priority": 1, "acceptance_criteria": "Given/When/Then"},
    {"title": "Implementer l'API", "description": "REST endpoint", "priority": 2, "acceptance_criteria": "AC"}
  ],
  "priorities": ["schema d'abord"],
  "risks": ["migration complexe"]
}
<<<END>>>`;

    const result = parseAgentOutput(raw, "pm");
    expect(result).not.toBeNull();
    expect((result as PmOutput).subtasks).toHaveLength(2);
    expect((result as PmOutput).risks).toContain("migration complexe");
  });

  it("parses architect output with decisions", () => {
    const raw = `<<<JSON>>>
{
  "design": "Event-driven avec Supabase Realtime",
  "components": [{"name": "EventBus", "responsibility": "routing", "interactions": ["DB"]}],
  "files_impacted": ["src/events.ts"],
  "patterns": ["pub-sub"],
  "technical_risks": ["latence reseau"],
  "decisions": [{"decision": "Supabase Realtime", "rationale": "deja en place", "alternatives": ["Redis Pub/Sub"]}]
}
<<<END>>>`;

    const result = parseAgentOutput(raw, "architect");
    expect(result).not.toBeNull();
    expect((result as ArchitectOutput).decisions).toHaveLength(1);
    expect((result as ArchitectOutput).design).toContain("Event-driven");
  });

  it("parses SM output", () => {
    const raw = `<<<JSON>>>
{
  "summary": "Sprint S22 en bonne voie",
  "blockers": [],
  "next_steps": ["deployer en staging", "tester e2e"],
  "follow_ups": ["review avec Edouard"]
}
<<<END>>>`;

    const result = parseAgentOutput(raw, "sm");
    expect(result).not.toBeNull();
    expect((result as SmOutput).next_steps).toHaveLength(2);
  });
});

// ── buildStructuredChainContext ──────────────────────────────

describe("buildStructuredChainContext", () => {
  it("returns empty string for no messages", () => {
    expect(buildStructuredChainContext([])).toBe("");
  });

  it("formats structured analyst output", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "analyst",
        agentName: "Mary",
        success: true,
        structured: {
          role: "analyst",
          analysis: "Tache faisable",
          risks: [{ severity: "low", description: "mineur" }],
          recommendations: ["POC d'abord"],
          dependencies: ["DB"],
          feasibility: "high",
        },
        rawOutput: "...",
        durationMs: 5000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Mary (analyst)");
    expect(context).toContain("Tache faisable");
    expect(context).toContain("Faisabilite: high");
    expect(context).toContain("[low] mineur");
    expect(context).toContain("POC d'abord");
  });

  it("falls back to raw output when no structured data", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "dev",
        agentName: "Amelia",
        success: true,
        structured: null,
        rawOutput: "Code modifie avec succes.",
        durationMs: 3000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Code modifie avec succes.");
  });

  it("skips failed agents", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "analyst",
        agentName: "Mary",
        success: false,
        structured: null,
        rawOutput: "erreur",
        durationMs: 1000,
        error: "timeout",
      },
      {
        agentId: "pm",
        agentName: "John",
        success: true,
        structured: {
          role: "pm",
          subtasks: [{ title: "t1", description: "d1", priority: 1, acceptance_criteria: "ac" }],
          priorities: ["t1 d'abord"],
          risks: [],
        },
        rawOutput: "...",
        durationMs: 4000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).not.toContain("Mary");
    expect(context).toContain("John (pm)");
  });

  it("formats multiple structured outputs", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "analyst",
        agentName: "Mary",
        success: true,
        structured: {
          role: "analyst",
          analysis: "OK",
          risks: [],
          recommendations: [],
          dependencies: [],
          feasibility: "high",
        },
        rawOutput: "...",
        durationMs: 2000,
      },
      {
        agentId: "pm",
        agentName: "John",
        success: true,
        structured: {
          role: "pm",
          subtasks: [{ title: "S1", description: "d", priority: 2, acceptance_criteria: "ac" }],
          priorities: ["faire S1"],
          risks: ["delai serre"],
        },
        rawOutput: "...",
        durationMs: 3000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Mary (analyst)");
    expect(context).toContain("John (pm)");
    expect(context).toContain("Faisabilite: high");
    expect(context).toContain("[P2] S1");
    expect(context).toContain("delai serre");
  });

  it("truncates long raw output at 2000 chars", () => {
    const longOutput = "x".repeat(3000);
    const messages: AgentMessage[] = [
      {
        agentId: "dev",
        agentName: "Amelia",
        success: true,
        structured: null,
        rawOutput: longOutput,
        durationMs: 5000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("...(tronque)");
    // Should not contain the full 3000 char string
    expect(context.length).toBeLessThan(longOutput.length);
  });

  it("formats QA structured output with score and findings", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "qa",
        agentName: "Quinn",
        success: true,
        structured: {
          role: "qa",
          score: 78,
          findings: [
            { severity: "important", description: "missing validation", suggestion: "add check" },
          ],
          summary: "Needs work",
          tests_missing: ["edge case"],
        },
        rawOutput: "...",
        durationMs: 6000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Score: 78/100");
    expect(context).toContain("[important] missing validation");
    expect(context).toContain("Tests manquants: edge case");
  });

  it("formats architect structured output with decisions", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "architect",
        agentName: "Winston",
        success: true,
        structured: {
          role: "architect",
          design: "Modular monolith",
          components: [{ name: "Core", responsibility: "business logic", interactions: ["DB"] }],
          files_impacted: ["src/core.ts", "src/db.ts"],
          patterns: ["repository"],
          technical_risks: ["migration"],
          decisions: [
            { decision: "Postgres", rationale: "already in use", alternatives: ["MongoDB"] },
          ],
        },
        rawOutput: "...",
        durationMs: 4000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Design: Modular monolith");
    expect(context).toContain("Core (business logic)");
    expect(context).toContain("src/core.ts");
    expect(context).toContain("Postgres (already in use)");
  });

  it("includes instruction for downstream agents", () => {
    const messages: AgentMessage[] = [
      {
        agentId: "analyst",
        agentName: "Mary",
        success: true,
        structured: null,
        rawOutput: "ok",
        durationMs: 1000,
      },
    ];

    const context = buildStructuredChainContext(messages);
    expect(context).toContain("Ne repete pas ce qui a deja ete fait");
  });
});

// ── ExplorationPhaseOutput ───────────────────────────────────

const VALID_EXPLORATION_OUTPUT: ExplorationPhaseOutput = {
  role: "explorer",
  domain: "authentification",
  findings: [
    {
      title: "OAuth2 standard",
      description: "Le protocole le plus repandu pour l'auth tierce",
      sources: ["src/auth.ts:42"],
      relevance: "high",
    },
  ],
  alternatives: [
    {
      label: "Passport.js",
      description: "Middleware Express pour auth",
      pros: ["ecosysteme riche", "facile a integrer"],
      cons: ["dependance lourde"],
      effort: "medium",
    },
  ],
  recommendation: "Utiliser Supabase Auth natif pour simplifier l'architecture",
  risks: [
    {
      severity: "medium",
      description: "Migration des sessions existantes",
      mitigation: "Migration progressive avec double auth pendant 2 sprints",
    },
  ],
  effort_estimate: "4-6h",
  confidence: 0.85,
  open_questions: ["Quel provider OAuth pour les comptes pro ?"],
};

describe("validateExplorationPhaseOutput", () => {
  it("validates a correct exploration phase output", () => {
    expect(validateExplorationPhaseOutput(VALID_EXPLORATION_OUTPUT)).toBe(true);
  });

  it("rejects null/undefined", () => {
    expect(validateExplorationPhaseOutput(null)).toBe(false);
    expect(validateExplorationPhaseOutput(undefined)).toBe(false);
  });

  it("rejects missing domain", () => {
    const { domain, ...rest } = VALID_EXPLORATION_OUTPUT;
    expect(validateExplorationPhaseOutput(rest)).toBe(false);
  });

  it("rejects missing findings array", () => {
    const { findings, ...rest } = VALID_EXPLORATION_OUTPUT;
    expect(validateExplorationPhaseOutput(rest)).toBe(false);
  });

  it("rejects missing recommendation", () => {
    const { recommendation, ...rest } = VALID_EXPLORATION_OUTPUT;
    expect(validateExplorationPhaseOutput(rest)).toBe(false);
  });

  it("rejects confidence out of range", () => {
    expect(validateExplorationPhaseOutput({ ...VALID_EXPLORATION_OUTPUT, confidence: 1.5 })).toBe(
      false,
    );
    expect(validateExplorationPhaseOutput({ ...VALID_EXPLORATION_OUTPUT, confidence: -0.1 })).toBe(
      false,
    );
  });

  it("accepts confidence at boundaries", () => {
    expect(validateExplorationPhaseOutput({ ...VALID_EXPLORATION_OUTPUT, confidence: 0 })).toBe(
      true,
    );
    expect(validateExplorationPhaseOutput({ ...VALID_EXPLORATION_OUTPUT, confidence: 1 })).toBe(
      true,
    );
  });
});

describe("parseExplorationPhaseOutput", () => {
  it("parses valid direct JSON", () => {
    const raw = JSON.stringify(VALID_EXPLORATION_OUTPUT);
    const result = parseExplorationPhaseOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("authentification");
    expect(result!.confidence).toBe(0.85);
    expect(result!.findings).toHaveLength(1);
  });

  it("parses JSON with <<<JSON>>> markers", () => {
    const raw = `Voici mon analyse.\n<<<JSON>>>\n${JSON.stringify(VALID_EXPLORATION_OUTPUT)}\n<<<END>>>\nFin.`;
    const result = parseExplorationPhaseOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("authentification");
  });

  it("parses JSON embedded in text", () => {
    const raw = `Some preamble text. ${JSON.stringify(VALID_EXPLORATION_OUTPUT)} Some trailing text.`;
    const result = parseExplorationPhaseOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.recommendation).toContain("Supabase Auth");
  });

  it("returns null for invalid JSON", () => {
    expect(parseExplorationPhaseOutput("not json at all")).toBeNull();
  });

  it("returns null for JSON that doesn't match schema", () => {
    const raw = JSON.stringify({ name: "irrelevant", value: 42 });
    expect(parseExplorationPhaseOutput(raw)).toBeNull();
  });
});

describe("formatExplorationPhaseOutput", () => {
  it("formats all sections", () => {
    const formatted = formatExplorationPhaseOutput(VALID_EXPLORATION_OUTPUT);
    expect(formatted).toContain("Domaine: authentification");
    expect(formatted).toContain("Confiance: 85%");
    expect(formatted).toContain("Recommandation:");
    expect(formatted).toContain("Decouvertes (1):");
    expect(formatted).toContain("OAuth2 standard");
    expect(formatted).toContain("Alternatives (1):");
    expect(formatted).toContain("Passport.js");
    expect(formatted).toContain("Risques:");
    expect(formatted).toContain("Effort estime: 4-6h");
    expect(formatted).toContain("Questions ouvertes:");
  });

  it("handles minimal output (no optional fields)", () => {
    const minimal: ExplorationPhaseOutput = {
      role: "explorer",
      domain: "test",
      findings: [],
      alternatives: [],
      recommendation: "rien a faire",
      risks: [],
      effort_estimate: "",
      confidence: 0.5,
      open_questions: [],
    };
    const formatted = formatExplorationPhaseOutput(minimal);
    expect(formatted).toContain("Domaine: test");
    expect(formatted).toContain("Confiance: 50%");
    expect(formatted).not.toContain("Decouvertes");
    expect(formatted).not.toContain("Alternatives");
  });
});

describe("getJsonSchemaForRole — exploration", () => {
  it("returns JSON Schema for exploration role", () => {
    const schema = getJsonSchemaForRole("exploration");
    expect(schema).not.toBeNull();
    expect((schema as any).required).toContain("domain");
    expect((schema as any).required).toContain("findings");
    expect((schema as any).required).toContain("confidence");
  });
});

describe("getSchemaForRole — exploration", () => {
  it("returns schema description for exploration role", () => {
    const schema = getSchemaForRole("exploration" as any);
    expect(schema.length).toBeGreaterThan(50);
    expect(schema).toContain("domain");
    expect(schema).toContain("findings");
    expect(schema).toContain("confidence");
  });
});
