/**
 * Generated tests — SPEC-sante-systeme-memoire-permanente-multi
 *
 * Slug: sante-systeme-memoire-permanente-multi
 * Spec: docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md
 *
 * Covers all 18 V-criteres:
 *   V1-V5 : orchestrator promotion integration (structural, source-based)
 *   V6-V10, V12, V14, V16, V17 : memoryHealthStats / formatMemoryHealth / promoteWorkingMemory (unit)
 *   V11, V18 : /brain health dispatch (structural, source-based)
 *   V13 : InMemoryBlackboard fallback (structural)
 *   V15 : auto-pipeline useBlackboard (structural)
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { MemoryHealthStats, WorkingMemoryData } from "../../src/memory.ts";
import {
  formatMemoryHealth,
  memoryHealthStats,
  PROMOTION_MAX_CHARS,
  promoteWorkingMemory,
} from "../../src/memory.ts";
import { createMockSupabase } from "../fixtures/mock-supabase.ts";

// ════════════════════════════════════════════════════════════════
// V-critere: V1 — promoteWorkingMemory appele en fin de pipeline (flag actif)
// ════════════════════════════════════════════════════════════════

// V-critere: V1
describe("[V1] promoteWorkingMemory appele quand flag memory_promotion actif et blackboard non-null", () => {
  it("orchestrator source contient le guard isFeatureEnabled('memory_promotion') && bbSessionId", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // Guard condition: feature flag AND bbSessionId
    const guardMatch = source.match(
      /if\s*\(\s*isFeatureEnabled\(\s*["']memory_promotion["']\s*\)\s*&&\s*bbSessionId\s*\)/,
    );
    expect(guardMatch).not.toBeNull();

    // Call to promoteWorkingMemory with supabase, wmForPromotion, bbSessionId
    const callMatch = source.match(
      /promoteWorkingMemory\(\s*supabase\s*,\s*wmForPromotion\s*,\s*bbSessionId\s*\)/,
    );
    expect(callMatch).not.toBeNull();

    // Working memory is read from blackboard section
    expect(source).toContain('readSection(supabase, bbSessionId, "working_memory")');
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V2 — promotion NON appelee quand flag inactif
// ════════════════════════════════════════════════════════════════

// V-critere: V2
describe("[V2] promoteWorkingMemory NON appelee quand flag memory_promotion inactif", () => {
  it("orchestrator source: promoteWorkingMemory est uniquement dans le bloc garde par isFeatureEnabled", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // The guard ensures promotion is skipped when flag is off
    const guardMatch = source.match(/if\s*\(\s*isFeatureEnabled\(\s*["']memory_promotion["']\s*\)/);
    expect(guardMatch).not.toBeNull();

    // promoteWorkingMemory appears exactly once (inside the guarded block)
    const lines = source.split("\n");
    const promoteCalls = lines.filter(
      (l) =>
        l.includes("promoteWorkingMemory(") &&
        !l.trimStart().startsWith("import") &&
        !l.trimStart().startsWith("//"),
    );
    expect(promoteCalls.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V3 — promotion NON appelee quand useBlackboard false
// ════════════════════════════════════════════════════════════════

// V-critere: V3
describe("[V3] promoteWorkingMemory NON appelee quand useBlackboard est false", () => {
  it("orchestrator source: bbSessionId initialise null, assigne seulement si useBlackboard", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // bbSessionId initialized to null — null guard prevents promotion
    const bbSessionInit = source.match(/let\s+bbSessionId:\s*string\s*\|\s*null\s*=\s*null/);
    expect(bbSessionInit).not.toBeNull();

    // bbSessionId assigned only inside if (options.useBlackboard)
    const bbAssignment = source.match(
      /if\s*\(\s*options\.useBlackboard\s*\)\s*\{[\s\S]*?bbSessionId\s*=\s*`bb-/,
    );
    expect(bbAssignment).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V4 — echec promoteWorkingMemory ne bloque pas orchestrate()
// ════════════════════════════════════════════════════════════════

// V-critere: V4
describe("[V4] echec de promoteWorkingMemory ne bloque pas le retour de orchestrate()", () => {
  it("orchestrator source: promotion est dans try/catch isole", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // try/catch wrapping promoteWorkingMemory
    const tryCatchMatch = source.match(
      /try\s*\{[\s\S]*?promoteWorkingMemory\([\s\S]*?\}\s*catch\s*\(\s*promoError\s*\)/,
    );
    expect(tryCatchMatch).not.toBeNull();

    // catch block logs error without re-throwing
    const catchBlock = source.match(
      /catch\s*\(\s*promoError\s*\)\s*\{[^}]*log\.error\([^)]*\)[^}]*\}/,
    );
    expect(catchBlock).not.toBeNull();

    // After the try/catch, the function continues to return orchestratedResult
    const afterPromotion = source.indexOf("promoteWorkingMemory(");
    const returnResult = source.indexOf("return orchestratedResult;", afterPromotion);
    expect(returnResult).toBeGreaterThan(afterPromotion);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V5 — compteur de promotions reporte via onProgress
// ════════════════════════════════════════════════════════════════

// V-critere: V5
describe("[V5] compteur de promotions reporte via onProgress", () => {
  it("orchestrator source: onProgress appele avec 'Working memory: N items promus' si promotedCount > 0", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // onProgress called conditionally when promotedCount > 0
    const progressMatch = source.match(
      /if\s*\(\s*promotedCount\s*>\s*0\s*&&\s*options\.onProgress\s*\)/,
    );
    expect(progressMatch).not.toBeNull();

    // Message includes the count
    const messageMatch = source.match(
      /options\.onProgress\(\s*`Working memory: \$\{promotedCount\} items promus en memoire permanente`[\s,]*\)/s,
    );
    expect(messageMatch).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V6 — memoryHealthStats retourne total par type
// ════════════════════════════════════════════════════════════════

// V-critere: V6
describe("[V6] memoryHealthStats retourne le total de memoires par type", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("retourne byType correct avec plusieurs types", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "F1",
      },
      {
        id: "2",
        type: "fact",
        importance_score: 70,
        created_at: now,
        access_count: 0,
        content: "F2",
      },
      {
        id: "3",
        type: "goal",
        importance_score: 80,
        created_at: now,
        access_count: 0,
        content: "G1",
      },
      {
        id: "4",
        type: "idea",
        importance_score: 30,
        created_at: now,
        access_count: 0,
        content: "I1",
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.total).toBe(4);
    expect(stats.byType.fact).toBe(2);
    expect(stats.byType.goal).toBe(1);
    expect(stats.byType.idea).toBe(1);
  });

  it("retourne total=0 et byType={} si table vide", async () => {
    const stats = await memoryHealthStats(supabase);
    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V7 — memoryHealthStats calcule le ratio d'embedding coverage
// ════════════════════════════════════════════════════════════════

// V-critere: V7
describe("[V7] memoryHealthStats calcule le ratio d'embedding coverage", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("2 sur 3 memoires avec embedding => coverage = 2/3", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        embedding: [0.1],
      },
      {
        id: "2",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "B",
        embedding: [0.2],
      },
      {
        id: "3",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "C",
        embedding: null,
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.embeddingCoverage).toBeCloseTo(2 / 3, 2);
  });

  it("100% coverage si toutes les memoires ont un embedding", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        embedding: [0.1],
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.embeddingCoverage).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V8 — memoryHealthStats retourne recentPromotions (7 jours, source = working_memory_promotion)
// ════════════════════════════════════════════════════════════════

// V-critere: V8
describe("[V8] memoryHealthStats retourne le nombre de promotions recentes (7 jours)", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("compte uniquement les promotions des 7 derniers jours avec source = working_memory_promotion", async () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "2",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "B",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "3",
        type: "fact",
        importance_score: 50,
        created_at: oldDate,
        access_count: 0,
        content: "C",
        metadata: { source: "working_memory_promotion" },
      }, // trop vieux
      {
        id: "4",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "D",
        metadata: { source: "manual" },
      }, // source differente
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.recentPromotions).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V9 — memoryHealthStats retourne 0/defauts si supabase null
// ════════════════════════════════════════════════════════════════

// V-critere: V9
describe("[V9] memoryHealthStats retourne valeurs par defaut si supabase est null", () => {
  it("retourne stats vides sans erreur", async () => {
    const stats = await memoryHealthStats(null);

    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.embeddingCoverage).toBe(0);
    expect(stats.avgImportanceScore).toBe(0);
    expect(stats.avgAgeDays).toBe(0);
    expect(stats.recentPromotions).toBe(0);
    expect(stats.linksCount).toBe(0);
    expect(stats.archiveCount).toBe(0);
    expect(stats.topAccessed).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V10 — formatMemoryHealth produit du plain text sans markdown
// ════════════════════════════════════════════════════════════════

// V-critere: V10
describe("[V10] formatMemoryHealth produit un texte lisible en plain text (pas de markdown)", () => {
  it("contient les champs attendus et aucun caractere markdown", () => {
    const stats: MemoryHealthStats = {
      total: 142,
      byType: { fact: 98, goal: 12, idea: 23, preference: 9 },
      embeddingCoverage: 0.92,
      avgImportanceScore: 47.3,
      avgAgeDays: 18.2,
      recentPromotions: 5,
      linksCount: 87,
      archiveCount: 34,
      topAccessed: [
        { content: "Bun runtime is the default", accessCount: 14 },
        { content: "Supabase schema uses memory table", accessCount: 11 },
      ],
    };

    const text = formatMemoryHealth(stats);

    // Required fields present
    expect(text).toContain("SANTE MEMOIRE");
    expect(text).toContain("Total: 142 memoires actives");
    expect(text).toContain("fact: 98");
    expect(text).toContain("goal: 12");
    expect(text).toContain("Embeddings: 131/142 (92%)");
    expect(text).toContain("Importance moyenne: 47.3");
    expect(text).toContain("Age moyen: 18.2 jours");
    expect(text).toContain("Liens semantiques: 87");
    expect(text).toContain("Archive: 34");
    expect(text).toContain("Promotions recentes (7j): 5");
    expect(text).toContain("Top acces:");
    expect(text).toContain("14x");

    // No markdown
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
    expect(text).not.toContain("```");
  });

  it("ne contient pas 'Top acces:' si topAccessed est vide", () => {
    const stats: MemoryHealthStats = {
      total: 0,
      byType: {},
      embeddingCoverage: 0,
      avgImportanceScore: 0,
      avgAgeDays: 0,
      recentPromotions: 0,
      linksCount: 0,
      archiveCount: 0,
      topAccessed: [],
    };

    const text = formatMemoryHealth(stats);

    expect(text).toContain("SANTE MEMOIRE");
    expect(text).toContain("Total: 0 memoires actives");
    expect(text).not.toContain("Top acces:");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V11 — /brain health repond avec les metriques formatees
// ════════════════════════════════════════════════════════════════

// V-critere: V11 (integration — structural)
describe("[V11] /brain health repond avec les metriques de sante memoire formatees", () => {
  it("memory-cmds source: quand brainInput === 'health', appelle memoryHealthStats et sendResponse avec formatMemoryHealth", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/commands/memory-cmds.ts", "utf-8");

    // memoryHealthStats and formatMemoryHealth are imported
    expect(source).toContain("memoryHealthStats");
    expect(source).toContain("formatMemoryHealth");

    // health dispatch block calls memoryHealthStats
    const healthBlock = source.match(
      /if\s*\(\s*brainInput\s*===\s*["']health["']\s*\)\s*\{[\s\S]*?memoryHealthStats\(/,
    );
    expect(healthBlock).not.toBeNull();

    // formatted result is sent via sendResponse
    const sendMatch = source.match(
      /memoryHealthStats\([\s\S]*?formatMemoryHealth\(\s*stats\s*\)[\s\S]*?sendResponse/,
    );
    expect(sendMatch).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V12 — flag memory_promotion dans config/features.json avec valeur false
// ════════════════════════════════════════════════════════════════

// V-critere: V12
describe("[V12] le flag memory_promotion existe dans config/features.json avec valeur false", () => {
  it("config/features.json contient memory_promotion: false", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const featuresPath = path.join(process.cwd(), "config", "features.json");
    const content = JSON.parse(fs.readFileSync(featuresPath, "utf-8"));
    expect(content.memory_promotion).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V13 — promotion fonctionne avec InMemoryBlackboard fallback
// ════════════════════════════════════════════════════════════════

// V-critere: V13 (structural)
describe("[V13] promotion fonctionne avec le fallback InMemoryBlackboard", () => {
  it("orchestrator source: lecture working_memory via bbFallback?.read() si supabase absent", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator/pipeline.ts", "utf-8");

    // The ternary handles both Supabase and InMemoryBlackboard paths
    const fallbackRead = source.match(
      /bbFallback\?\.read\(\s*bbSessionId\s*,\s*["']working_memory["']\s*\)/,
    );
    expect(fallbackRead).not.toBeNull();

    // The condition: supabase && !bbFallback uses Supabase, otherwise uses bbFallback
    const ternaryMatch = source.match(
      /supabase\s*&&\s*!bbFallback[\s\S]*?readSection\([\s\S]*?\)\s*:\s*.*bbFallback\?\.read\(/,
    );
    expect(ternaryMatch).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V14 — memoryHealthStats calcule score importance moyen et age moyen
// ════════════════════════════════════════════════════════════════

// V-critere: V14
describe("[V14] memoryHealthStats calcule le score d'importance moyen et l'age moyen en jours", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("calcule la moyenne des scores et des ages avec des donnees connues", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    supabase._store.memory = [
      {
        id: "1",
        type: "fact",
        importance_score: 40,
        created_at: twoDaysAgo,
        access_count: 0,
        content: "A",
      },
      {
        id: "2",
        type: "fact",
        importance_score: 60,
        created_at: fourDaysAgo,
        access_count: 0,
        content: "B",
      },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.avgImportanceScore).toBe(50); // (40+60)/2
    expect(stats.avgAgeDays).toBeGreaterThan(2.5);
    expect(stats.avgAgeDays).toBeLessThan(3.5); // ~3 jours en moyenne
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V15 — auto-pipeline.ts appelle orchestrate() avec useBlackboard: true
// ════════════════════════════════════════════════════════════════

// V-critere: V15 (structural)
describe("[V15] auto-pipeline.ts appelle orchestrate() avec useBlackboard: true", () => {
  it("auto-pipeline source: l'appel orchestrate() contient useBlackboard: true", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/auto-pipeline.ts", "utf-8");

    const orchestrateCallMatch = source.match(
      /orchestrate\(supabase,\s*task,\s*\{[\s\S]*?useBlackboard:\s*true[\s\S]*?\}\)/,
    );
    expect(orchestrateCallMatch).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V16 — memoryHealthStats retourne 0 pour avgImportanceScore et avgAgeDays quand total=0
// ════════════════════════════════════════════════════════════════

// V-critere: V16
describe("[V16] memoryHealthStats retourne 0 pour les moyennes quand la table memory est vide (pas de NaN)", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("table vide => avgImportanceScore=0, avgAgeDays=0, pas de NaN", async () => {
    const stats = await memoryHealthStats(supabase);

    expect(stats.total).toBe(0);
    expect(stats.avgImportanceScore).toBe(0);
    expect(stats.avgAgeDays).toBe(0);
    expect(Number.isNaN(stats.avgImportanceScore)).toBe(false);
    expect(Number.isNaN(stats.avgAgeDays)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V17 — items promus tronques a 500 caracteres avant insertion
// ════════════════════════════════════════════════════════════════

// V-critere: V17
describe("[V17] les items promus sont tronques a 500 caracteres avant insertion", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerFunction("search", () => []);
  });

  it("decision de 1000 chars tronquee a PROMOTION_MAX_CHARS (500)", async () => {
    const longDecision = "A".repeat(1000);
    const wm: WorkingMemoryData = {
      decisions: [{ agent: "architect", decision: longDecision, reasoning: "B" }],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-trunc");

    expect(count).toBe(1);
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(1);
    expect(memory[0].content.length).toBeLessThanOrEqual(PROMOTION_MAX_CHARS);
    expect(memory[0].metadata.truncated).toBe(true);
  });

  it("decision courte non tronquee, pas de flag truncated", async () => {
    const wm: WorkingMemoryData = {
      decisions: [{ agent: "dev", decision: "Use REST", reasoning: "Simple" }],
    };

    const count = await promoteWorkingMemory(supabase, wm, "session-short");

    expect(count).toBe(1);
    const memory = supabase._getTable("memory");
    expect(memory[0].metadata.truncated).toBeUndefined();
  });

  it("PROMOTION_MAX_CHARS est bien 500", () => {
    expect(PROMOTION_MAX_CHARS).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V18 — /brain health dispatch uniquement sur match exact "health"
// ════════════════════════════════════════════════════════════════

// V-critere: V18 (integration — structural)
describe("[V18] /brain health dispatch uniquement sur match exact 'health', tout autre texte va au LLM", () => {
  it("memory-cmds source: strict equality === 'health', pas de startsWith/includes", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/commands/memory-cmds.ts", "utf-8");

    // Input is trimmed before comparison
    const trimMatch = source.match(
      /const\s+brainInput\s*=\s*\(ctx\.match\s*\|\|\s*["']["']\)\.toString\(\)\.trim\(\)/,
    );
    expect(trimMatch).not.toBeNull();

    // Strict equality with "health"
    const exactMatch = source.match(/brainInput\s*===\s*["']health["']/);
    expect(exactMatch).not.toBeNull();

    // No loose matching (startsWith or includes "health")
    const looseMatch = source.match(/brainInput\.(startsWith|includes)\(\s*["']health["']\s*\)/);
    expect(looseMatch).toBeNull();

    // health block has early return so non-matching text falls through to LLM
    const earlyReturn = source.match(
      /if\s*\(\s*brainInput\s*===\s*["']health["']\s*\)\s*\{[\s\S]*?return;\s*\}/,
    );
    expect(earlyReturn).not.toBeNull();
  });
});
