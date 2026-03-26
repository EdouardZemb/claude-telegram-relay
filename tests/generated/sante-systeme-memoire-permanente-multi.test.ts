/**
 * Generated tests — SPEC-sante-systeme-memoire-permanente-multi
 *
 * Slug: sante-systeme-memoire-permanente-multi
 * Spec: docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md
 *
 * V-criteres couverts (post-nettoyage-du-code-mort) :
 *   V6, V7, V8, V9, V14, V16 : memoryHealthStats (unit, mock Supabase)
 *   V10 : formatMemoryHealth (unit, HTML assertions)
 *   V11, V18 : /brain health dispatch (structural, source-based)
 *
 * Corrections adversariales (cycle 3) couvertes :
 *   F-EC-1/F-SS-1 : LIMIT 5000 sur allMemories + COUNT SQL pour linksCount/archiveCount/embeddingCount/recentPromotions
 *   F-EC-3 : index idx_memory_metadata_source dans schema.sql
 *
 * V-criteres retires (code supprime dans nettoyage-du-code-mort) :
 *   V1-V5 : promoteWorkingMemory (supprime — orchestrator.ts retire)
 *   V12 : memory_promotion flag (supprime — flag retire de features.json)
 *   V13 : InMemoryBlackboard fallback (supprime — promoteWorkingMemory retire)
 *   V15 : auto-pipeline useBlackboard (supprime — auto-pipeline.ts retire)
 *   V17 : troncature 500 chars (supprime — promoteWorkingMemory retire)
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { MemoryHealthStats } from "../../src/memory.ts";
import { formatMemoryHealth, memoryHealthStats } from "../../src/memory.ts";
import { createMockSupabase } from "../fixtures/mock-supabase.ts";

// ════════════════════════════════════════════════════════════════
// V-critere: V6 — memoryHealthStats retourne total par type
// ════════════════════════════════════════════════════════════════

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
// V-critere: V10 — formatMemoryHealth produit du HTML lisible (pas de markdown)
// ════════════════════════════════════════════════════════════════

describe("[V10] formatMemoryHealth produit un texte HTML lisible (pas de markdown)", () => {
  it("contient les champs attendus en HTML et aucun caractere markdown", () => {
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

    // HTML header (sectionTitle wraps in <b>)
    expect(text).toContain("<b>Sante memoire</b>");

    // Total line
    expect(text).toContain("142 memoires actives");

    // Type breakdown
    expect(text).toContain("fact");
    expect(text).toContain("98");
    expect(text).toContain("goal");
    expect(text).toContain("12");

    // Embeddings (progressBar format: "XX%")
    expect(text).toContain("Embeddings");
    expect(text).toContain("92%");

    // kvLine fields (HTML encoded)
    expect(text).toContain("Importance moyenne");
    expect(text).toContain("47.3");
    expect(text).toContain("Age moyen");
    expect(text).toContain("18.2 jours");
    expect(text).toContain("Liens semantiques");
    expect(text).toContain("87");
    expect(text).toContain("Archive");
    expect(text).toContain("34");
    expect(text).toContain("Promotions recentes (7j)");
    expect(text).toContain("5");

    // Top accessed
    expect(text).toContain("Top acces");
    expect(text).toContain("14x");

    // No markdown chars
    expect(text).not.toContain("**");
    expect(text).not.toContain("##");
    expect(text).not.toContain("```");
  });

  it("ne contient pas 'Top acces' si topAccessed est vide", () => {
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

    expect(text).toContain("Sante memoire");
    expect(text).toContain("0 memoires actives");
    expect(text).not.toContain("<b>Top acces</b>");
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V11 — /brain health repond avec les metriques formatees
// ════════════════════════════════════════════════════════════════

describe("[V11] /brain health repond avec les metriques de sante memoire formatees", () => {
  it("memory-cmds source: quand brainInput === 'health', appelle memoryHealthStats et sendResponseHtml avec formatMemoryHealth", async () => {
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

    // formatted result is sent via sendResponseHtml (HTML formatting for memory health)
    const sendMatch = source.match(
      /memoryHealthStats\([\s\S]*?formatMemoryHealth\(\s*stats\s*\)[\s\S]*?sendResponseHtml/,
    );
    expect(sendMatch).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// V-critere: V14 — memoryHealthStats calcule score importance moyen et age moyen
// ════════════════════════════════════════════════════════════════

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
// V-critere: V16 — memoryHealthStats retourne 0 pour les moyennes quand total=0
// ════════════════════════════════════════════════════════════════

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
// V-critere: V18 — /brain health dispatch uniquement sur match exact "health"
// ════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════
// Corrections adversariales cycle 3 — F-EC-1/F-SS-1 :
// COUNT SQL pour linksCount, archiveCount, embeddingCount, recentPromotions
// ════════════════════════════════════════════════════════════════

describe("[F-EC-1/F-EC-4] memoryHealthStats utilise COUNT SQL pour linksCount et archiveCount", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("linksCount reflète le nombre de rows dans memory_links sans fetcher les donnees", async () => {
    const now = new Date().toISOString();
    // Setup a memory row so total > 0 (sinon early return sur empty)
    supabase._store.memory = [
      {
        id: "m1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
      },
    ];
    supabase._store.memory_links = [
      { id: "l1", source_id: "m1", target_id: "m2" },
      { id: "l2", source_id: "m2", target_id: "m1" },
      { id: "l3", source_id: "m1", target_id: "m3" },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.linksCount).toBe(3);
  });

  it("archiveCount reflète le nombre de rows dans memory_archive sans fetcher les donnees", async () => {
    const now = new Date().toISOString();
    supabase._store.memory = [
      {
        id: "m1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
      },
    ];
    supabase._store.memory_archive = [
      { id: "a1", type: "fact", archived_at: now },
      { id: "a2", type: "goal", archived_at: now },
    ];

    const stats = await memoryHealthStats(supabase);

    expect(stats.archiveCount).toBe(2);
  });

  it("recentPromotions utilise COUNT SQL (count property) et filtre par source et date", async () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    supabase._store.memory = [
      {
        id: "m1",
        type: "fact",
        importance_score: 50,
        created_at: now,
        access_count: 0,
        content: "A",
        metadata: { source: "working_memory_promotion" },
      },
      {
        id: "m2",
        type: "fact",
        importance_score: 50,
        created_at: oldDate,
        access_count: 0,
        content: "B",
        metadata: { source: "working_memory_promotion" },
      }, // trop vieux
    ];

    const stats = await memoryHealthStats(supabase);

    // Only 1 recent promotion (m2 is too old)
    expect(stats.recentPromotions).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Corrections adversariales cycle 3 — F-EC-3 :
// Index idx_memory_metadata_source dans db/schema.sql
// ════════════════════════════════════════════════════════════════

describe("[F-EC-3] schema.sql contient idx_memory_metadata_source pour les requetes recentPromotions", () => {
  it("db/schema.sql definit idx_memory_metadata_source sur memory.metadata->>'source'", async () => {
    const fs = await import("fs");
    const schema = fs.readFileSync("db/schema.sql", "utf-8");

    expect(schema).toContain("idx_memory_metadata_source");
    expect(schema).toContain("metadata->>'source'");
  });
});

// ════════════════════════════════════════════════════════════════
// Corrections adversariales cycle 3 — F-EC-1 :
// LIMIT 5000 sur la query allMemories (protection contre full table scan)
// ════════════════════════════════════════════════════════════════

describe("[F-EC-1] memoryHealthStats applique LIMIT 5000 sur la query allMemories", () => {
  it("graph.ts source: la query allMemories utilise .limit(5000)", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/memory/graph.ts", "utf-8");

    // allMemories query should have a LIMIT
    const limitMatch = source.match(
      /from\("memory"\)\s*\n?\s*\.select\("type, importance_score, created_at, access_count"\)\s*\n?\s*\.limit\(5000\)/,
    );
    expect(limitMatch).not.toBeNull();
  });
});
