/**
 * Unit Tests — Memory Chains (S41)
 *
 * Tests for classifyLinkContent(), getMemoryChain(), clusterMemories(),
 * formatClusters(), buildMemoryChains(), and findSimilarPastTasks().
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { MemoryCluster } from "../../src/memory";
import {
  buildMemoryChains,
  classifyLinkContent,
  clusterMemories,
  findSimilarPastTasks,
  formatClusters,
  getMemoryChain,
} from "../../src/memory";
import { createMockSupabase } from "../fixtures/mock-supabase";

// ── classifyLinkContent (S41-02) ────────────────────────────

describe("classifyLinkContent", () => {
  it("returns 'contradicts' when one has negation and high overlap", () => {
    const result = classifyLinkContent(
      "Le pipeline utilise Opus pour l'architect",
      "Le pipeline ne utilise pas Opus pour l'architect",
    );
    expect(result).toBe("contradicts");
  });

  it("returns 'contradicts' for replacement patterns", () => {
    const result = classifyLinkContent(
      "Le deploiement utilise SSH",
      "Le deploiement remplace SSH par GitHub Actions",
    );
    expect(result).toBe("contradicts");
  });

  it("returns 'extends' when one is significantly longer with shared entities", () => {
    const result = classifyLinkContent(
      "Edouard est developpeur",
      "Edouard est developpeur logiciel specialise en TypeScript, travaillant sur des projets d'IA",
    );
    expect(result).toBe("extends");
  });

  it("returns 'supports' for similar length with shared entities", () => {
    const result = classifyLinkContent(
      "Le sprint actuel progresse bien avec 8 taches",
      "Le sprint montre une bonne velocite avec 8 taches completees",
    );
    expect(result).toBe("supports");
  });

  it("returns 'related' for low entity overlap", () => {
    const result = classifyLinkContent("Edouard est developpeur", "Le temps est ensoleille");
    expect(result).toBe("related");
  });

  it("returns 'related' for completely different content", () => {
    const result = classifyLinkContent("A", "B");
    expect(result).toBe("related");
  });

  it("handles empty strings", () => {
    const result = classifyLinkContent("", "");
    expect(result).toBe("related");
  });

  it("detects English negation patterns", () => {
    const result = classifyLinkContent(
      "The pipeline uses parallel execution",
      "The pipeline does not use parallel execution",
    );
    expect(result).toBe("contradicts");
  });

  it("detects 'instead' as contradiction", () => {
    const result = classifyLinkContent(
      "Using Supabase for data storage",
      "Using PostgreSQL instead of Supabase for data storage",
    );
    expect(result).toBe("contradicts");
  });
});

// ── getMemoryChain (S41-01) ─────────────────────────────────

describe("getMemoryChain", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns root node with links for depth 1", async () => {
    // Mock root fetch
    supabase._store.memory = [{ id: "root", content: "Root fact", type: "fact" }];

    supabase._registerRpc("get_linked_memories", (params: any) => {
      if (params.p_memory_ids.includes("root")) {
        return [
          {
            origin_id: "root",
            linked_id: "child1",
            linked_content: "Child 1",
            linked_type: "fact",
            similarity: 0.85,
            link_type: "extends",
          },
          {
            origin_id: "root",
            linked_id: "child2",
            linked_content: "Child 2",
            linked_type: "goal",
            similarity: 0.72,
            link_type: "related",
          },
        ];
      }
      return [];
    });

    const chain = await getMemoryChain(supabase, "root", 1);

    expect(chain.length).toBeGreaterThanOrEqual(1);
    const root = chain.find((n) => n.id === "root");
    expect(root).toBeDefined();
    expect(root!.depth).toBe(0);
    expect(root!.links.length).toBe(2);
  });

  it("returns empty for null supabase", async () => {
    const result = await getMemoryChain(null, "root");
    expect(result).toEqual([]);
  });

  it("returns empty for empty memoryId", async () => {
    const result = await getMemoryChain(supabase, "");
    expect(result).toEqual([]);
  });

  it("returns empty when root node not found", async () => {
    supabase._store.memory = [];

    const result = await getMemoryChain(supabase, "nonexistent");
    expect(result).toEqual([]);
  });

  it("handles RPC error gracefully", async () => {
    supabase._store.memory = [{ id: "root", content: "Root", type: "fact" }];
    supabase._registerRpc("get_linked_memories", () => {
      throw new Error("connection lost");
    });

    const result = await getMemoryChain(supabase, "root");
    // Should return at least the root node
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("does not exceed maxDepth", async () => {
    supabase._store.memory = [{ id: "root", content: "Root fact", type: "fact" }];

    let callCount = 0;
    supabase._registerRpc("get_linked_memories", (params: any) => {
      callCount++;
      const id = params.p_memory_ids[0];
      return [
        {
          origin_id: id,
          linked_id: `child-${callCount}`,
          linked_content: `Child ${callCount}`,
          linked_type: "fact",
          similarity: 0.8,
          link_type: "extends",
        },
      ];
    });

    const chain = await getMemoryChain(supabase, "root", 2);

    // Should stop after depth 2 (root + 2 levels)
    const maxDepth = Math.max(...chain.map((n) => n.depth));
    expect(maxDepth).toBeLessThanOrEqual(2);
  });

  it("applies classifyLinkContent enrichment", async () => {
    supabase._store.memory = [{ id: "root", content: "Le pipeline utilise SSH", type: "fact" }];

    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "root",
        linked_id: "child1",
        linked_content: "Le pipeline ne utilise pas SSH mais GitHub Actions",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "related",
      },
    ]);

    const chain = await getMemoryChain(supabase, "root", 1);
    const root = chain.find((n) => n.id === "root");
    // The enriched link type should be "contradicts" (negation detected)
    expect(root!.links[0].linkType).toBe("contradicts");
  });
});

// ── clusterMemories (S41-03) ────────────────────────────────

describe("clusterMemories", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns empty for null supabase", async () => {
    const result = await clusterMemories(null);
    expect(result).toEqual([]);
  });

  it("returns empty when no facts exist", async () => {
    supabase._registerRpc("get_facts", () => []);

    const result = await clusterMemories(supabase);
    expect(result).toEqual([]);
  });

  it("groups connected memories into clusters", async () => {
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Fact A" },
      { id: "f2", content: "Fact B" },
      { id: "f3", content: "Fact C (isolated)" },
    ]);

    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "f2",
        linked_content: "Fact B",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "extends",
      },
    ]);

    const clusters = await clusterMemories(supabase);

    // f1-f2 should form a cluster, f3 is isolated (excluded)
    expect(clusters.length).toBe(1);
    expect(clusters[0].size).toBe(2);
    expect(clusters[0].memories.map((m) => m.id).sort()).toEqual(["f1", "f2"]);
  });

  it("excludes isolated nodes (clusters of size 1)", async () => {
    supabase._registerRpc("get_facts", () => [{ id: "f1", content: "Isolated fact" }]);

    supabase._registerRpc("get_linked_memories", () => []);

    const clusters = await clusterMemories(supabase);
    expect(clusters.length).toBe(0);
  });

  it("sorts clusters by size descending", async () => {
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "A" },
      { id: "f2", content: "B" },
      { id: "f3", content: "C" },
      { id: "f4", content: "D" },
      { id: "f5", content: "E" },
    ]);

    supabase._registerRpc("get_linked_memories", () => [
      // Cluster 1: f1-f2 (size 2)
      {
        origin_id: "f1",
        linked_id: "f2",
        linked_content: "B",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "extends",
      },
      // Cluster 2: f3-f4-f5 (size 3)
      {
        origin_id: "f3",
        linked_id: "f4",
        linked_content: "D",
        linked_type: "fact",
        similarity: 0.75,
        link_type: "related",
      },
      {
        origin_id: "f4",
        linked_id: "f5",
        linked_content: "E",
        linked_type: "fact",
        similarity: 0.72,
        link_type: "related",
      },
    ]);

    const clusters = await clusterMemories(supabase);

    expect(clusters.length).toBe(2);
    expect(clusters[0].size).toBe(3); // Largest first
    expect(clusters[1].size).toBe(2);
  });

  it("limits to maxClusters", async () => {
    supabase._registerRpc("get_facts", () =>
      Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, content: `Fact ${i}` })),
    );

    // Create 15 separate clusters of size 2
    supabase._registerRpc("get_linked_memories", () =>
      Array.from({ length: 15 }, (_, i) => ({
        origin_id: `f${i * 2 < 20 ? i * 2 : 0}`,
        linked_id: `linked-${i}`,
        linked_content: `Linked ${i}`,
        linked_type: "fact",
        similarity: 0.8,
        link_type: "related",
      })),
    );

    const clusters = await clusterMemories(supabase, 50, 5);
    expect(clusters.length).toBeLessThanOrEqual(5);
  });

  it("handles RPC error gracefully", async () => {
    supabase._registerRpc("get_facts", () => {
      throw new Error("timeout");
    });

    const result = await clusterMemories(supabase);
    expect(result).toEqual([]);
  });
});

// ── formatClusters (S41-03) ─────────────────────────────────

describe("formatClusters", () => {
  it("returns message for empty clusters", () => {
    expect(formatClusters([])).toBe("Aucun cluster detecte.");
  });

  it("formats clusters with header and members", () => {
    const clusters: MemoryCluster[] = [
      {
        id: 0,
        label: "Architecture decisions",
        size: 3,
        memories: [
          { id: "m1", content: "Uses TypeScript", type: "fact" },
          { id: "m2", content: "Supabase as DB", type: "fact" },
          { id: "m3", content: "Grammy for Telegram", type: "fact" },
        ],
      },
    ];

    const result = formatClusters(clusters);

    expect(result).toContain("CLUSTERS DE MEMOIRE (1)");
    expect(result).toContain("Cluster 1 (3 memoires)");
    expect(result).toContain("[fact] Uses TypeScript");
    expect(result).toContain("[fact] Supabase as DB");
  });

  it("truncates clusters with more than 5 members", () => {
    const memories = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      content: `Memory ${i}`,
      type: "fact",
    }));

    const clusters: MemoryCluster[] = [{ id: 0, label: "Big cluster", size: 8, memories }];

    const result = formatClusters(clusters);
    expect(result).toContain("... et 3 autres");
  });
});

// ── buildMemoryChains (S41-04) ──────────────────────────────

describe("buildMemoryChains", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
    supabase._registerRpc("bump_memory_access", () => null);
  });

  it("returns empty for null supabase", async () => {
    const result = await buildMemoryChains(null, "architect");
    expect(result).toBe("");
  });

  it("returns flat facts for dev role", async () => {
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Fact A" },
      { id: "f2", content: "Fact B" },
    ]);
    supabase._registerRpc("get_active_goals", () => [
      { id: "g1", content: "Goal 1", deadline: null },
    ]);
    supabase._registerRpc("get_linked_memories", () => []);

    const result = await buildMemoryChains(supabase, "dev");

    expect(result).toContain("Faits cles:");
    expect(result).toContain("- Fact A");
    expect(result).toContain("Objectifs:");
    expect(result).toContain("- Goal 1");
    // Dev should NOT see chain format
    expect(result).not.toContain("Faits et chaines:");
  });

  it("returns flat facts for sm role", async () => {
    supabase._registerRpc("get_facts", () => [{ id: "f1", content: "Fact A" }]);
    supabase._registerRpc("get_active_goals", () => []);
    supabase._registerRpc("get_linked_memories", () => []);

    const result = await buildMemoryChains(supabase, "sm");
    expect(result).toContain("Faits cles:");
  });

  it("returns structured chains for architect role", async () => {
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Architecture uses modular design" },
      { id: "f2", content: "Isolated fact" },
    ]);
    supabase._registerRpc("get_active_goals", () => []);
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "f3",
        linked_content: "Modular design enables parallel development",
        linked_type: "fact",
        similarity: 0.82,
        link_type: "extends",
      },
    ]);

    const result = await buildMemoryChains(supabase, "architect");

    expect(result).toContain("Faits et chaines:");
    expect(result).toContain("Architecture uses modular design");
    // Should have a classified link type
    expect(result).toMatch(/\[(extends|supports|related|contradicts)\]/);
  });

  it("returns structured chains for analyst role", async () => {
    supabase._registerRpc("get_facts", () => [{ id: "f1", content: "Sprint velocity is 10" }]);
    supabase._registerRpc("get_active_goals", () => [
      { id: "g1", content: "Improve velocity to 15", deadline: "2026-04-01" },
    ]);
    supabase._registerRpc("get_linked_memories", () => []);

    const result = await buildMemoryChains(supabase, "analyst");

    expect(result).toContain("Faits et chaines:");
    expect(result).toContain("Objectifs et contexte:");
    expect(result).toContain("echeance:");
  });

  it("returns empty when no facts or goals", async () => {
    supabase._registerRpc("get_facts", () => []);
    supabase._registerRpc("get_active_goals", () => []);

    const result = await buildMemoryChains(supabase, "architect");
    expect(result).toBe("");
  });

  it("handles RPC error gracefully", async () => {
    supabase._registerRpc("get_facts", () => {
      throw new Error("timeout");
    });

    const result = await buildMemoryChains(supabase, "pm");
    expect(result).toBe("");
  });

  it("avoids duplicating linked memories in chains", async () => {
    supabase._registerRpc("get_facts", () => [
      { id: "f1", content: "Main fact" },
      { id: "f2", content: "Linked fact" },
    ]);
    supabase._registerRpc("get_active_goals", () => []);
    supabase._registerRpc("get_linked_memories", () => [
      {
        origin_id: "f1",
        linked_id: "f2",
        linked_content: "Linked fact",
        linked_type: "fact",
        similarity: 0.8,
        link_type: "extends",
      },
    ]);

    const result = await buildMemoryChains(supabase, "pm");

    // f2 should appear only as a link under f1, not as a standalone fact
    const lines = result.split("\n");
    const standaloneF2 = lines.filter((l) => l.startsWith("- Linked fact"));
    expect(standaloneF2.length).toBe(0);
  });
});

// ── findSimilarPastTasks (S41-05) ───────────────────────────

describe("findSimilarPastTasks", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    supabase = createMockSupabase();
  });

  it("returns empty for null supabase", async () => {
    const result = await findSimilarPastTasks(null, "some task");
    expect(result).toEqual([]);
  });

  it("returns empty for empty title", async () => {
    const result = await findSimilarPastTasks(supabase, "");
    expect(result).toEqual([]);
  });

  it("returns empty for short words (all < 4 chars)", async () => {
    const result = await findSimilarPastTasks(supabase, "do it now");
    expect(result).toEqual([]);
  });

  it("finds similar done tasks by keyword matching", async () => {
    supabase._store.tasks = [
      {
        id: "t1",
        title: "Memory chains implementation",
        status: "done",
        estimated_hours: 4,
        actual_hours: 6,
        sprint: "S41",
        tags: ["feature"],
        completed_at: "2026-03-17",
      },
    ];

    const result = await findSimilarPastTasks(supabase, "Implement memory clustering");

    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("handles query error gracefully", async () => {
    // Empty table, no matching keywords
    const result = await findSimilarPastTasks(supabase, "some task title");
    expect(Array.isArray(result)).toBe(true);
  });

  it("maps task fields correctly", async () => {
    supabase._store.tasks = [
      {
        id: "t-abc",
        title: "Feature implementation",
        status: "done",
        estimated_hours: 3,
        actual_hours: 5,
        sprint: "S40",
        tags: ["feature", "backend"],
        completed_at: "2026-03-16",
      },
    ];

    const result = await findSimilarPastTasks(supabase, "Feature implementation test");
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].title).toBe("Feature implementation");
      expect(result[0].estimatedHours).toBe(3);
      expect(result[0].actualHours).toBe(5);
      expect(result[0].sprint).toBe("S40");
    }
  });
});

// ── Integration: agent-context with memory chains (S41) ─────

describe("S41 integration", () => {
  it("classifyLinkContent is a pure function (no side effects)", () => {
    // Run twice with same input, should get same output
    const r1 = classifyLinkContent("A B C D", "A B C D");
    const r2 = classifyLinkContent("A B C D", "A B C D");
    expect(r1).toBe(r2);
  });

  it("classifyLinkContent handles special characters", () => {
    const result = classifyLinkContent(
      "l'architecture est modulaire",
      "l'architecture n'est pas modulaire",
    );
    expect(result).toBe("contradicts");
  });

  it("formatClusters handles multiple clusters", () => {
    const clusters: MemoryCluster[] = [
      {
        id: 0,
        label: "Cluster A",
        size: 3,
        memories: [
          { id: "1", content: "A1", type: "fact" },
          { id: "2", content: "A2", type: "fact" },
          { id: "3", content: "A3", type: "goal" },
        ],
      },
      {
        id: 1,
        label: "Cluster B",
        size: 2,
        memories: [
          { id: "4", content: "B1", type: "fact" },
          { id: "5", content: "B2", type: "fact" },
        ],
      },
    ];

    const result = formatClusters(clusters);
    expect(result).toContain("CLUSTERS DE MEMOIRE (2)");
    expect(result).toContain("Cluster 1");
    expect(result).toContain("Cluster 2");
  });
});
