/**
 * @module memory.graph
 * @description Memory linking, chains, clustering, health stats,
 * similar tasks, agent memory chains.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureEnabled } from "../feature-flags.ts";
import { kvLine, progressBar, sectionTitle, separator } from "../html-format-helpers.ts";
import { escapeHtml } from "../html-utils.ts";
import { createLogger } from "../logger.ts";
import { getAgentMemories } from "./agent-memory.ts";
import { classifyLinkContent } from "./classification.ts";
import { bumpMemoryAccess } from "./scoring.ts";

const log = createLogger("memory.graph");

// ── Constants ─────────────────────────────────────────────────

/** Hard limit of role-specific memories per role (R7) */
export const AGENT_MEMORY_HARD_LIMIT = 15;

/** Max linked memories shown per memory in context */
const MAX_LINKS_PER_MEMORY_IN_CONTEXT = 3;

/** Max facts injected into prompt context */
const MAX_FACTS_IN_CONTEXT = 20;

/** Max goals injected into prompt context */
const MAX_GOALS_IN_CONTEXT = 10;

/** Max nodes in a chain traversal */
const MAX_CHAIN_NODES = 50;

// ── Interfaces ────────────────────────────────────────────────

/** A cluster of semantically related memories */
export interface MemoryCluster {
  id: number;
  label: string;
  memories: Array<{ id: string; content: string; type: string }>;
  size: number;
}

/** A node in a multi-hop memory chain (from getMemoryChain) */
export interface MemoryChain {
  id: string;
  content: string;
  type: string;
  depth: number;
  links: Array<{
    targetId: string;
    similarity: number;
    linkType: string;
  }>;
}

/** A linked memory returned by get_linked_memories RPC */
export interface LinkedMemory {
  origin_id: string;
  linked_id: string;
  linked_content: string;
  linked_type: string;
  similarity: number;
  link_type: string;
}

/** Memory statistics summary */
export interface MemoryHealthStats {
  total: number;
  byType: Record<string, number>;
  embeddingCoverage: number;
  avgImportanceScore: number;
  avgAgeDays: number;
  recentPromotions: number;
  linksCount: number;
  archiveCount: number;
  topAccessed: Array<{ content: string; accessCount: number }>;
}

/** A completed task similar to the current one */
export interface SimilarTask {
  id: string;
  title: string;
  estimatedHours: number | null;
  actualHours: number | null;
  sprint: string | null;
  tags: string[];
}

/** A fact from get_facts RPC */
interface FactRecord {
  id: string;
  content: string;
  importance_score: number;
  access_count: number;
}

/** A goal from get_active_goals RPC */
interface GoalRecord {
  id: string;
  content: string;
  deadline: string | null;
  priority: number;
  importance_score: number;
}

// ── Memory Linking (S36-01) ───────────────────────────────────

/**
 * Create semantic links between a memory and its nearest neighbors.
 * Wraps the link_memory RPC. The DB trigger handles auto-linking on
 * embedding creation; this function is for manual/on-demand use.
 *
 * @returns Number of links created (forward + reverse)
 */
export async function linkMemories(
  supabase: SupabaseClient | null,
  memoryId: string,
  threshold?: number,
  maxLinks?: number,
): Promise<number> {
  if (!supabase || !memoryId) return 0;

  try {
    const params: Record<string, string | number> = { p_memory_id: memoryId };
    if (threshold !== undefined) params.p_threshold = threshold;
    if (maxLinks !== undefined) params.p_max_links = maxLinks;

    const { data, error } = await supabase.rpc("link_memory", params);

    if (error) {
      log.error("link_memory error", { error: String(error) });
      return 0;
    }

    return data || 0;
  } catch (error) {
    log.error("link_memory error", { error: String(error) });
    return 0;
  }
}

// ── Memory Link Retrieval (S36-02) ────────────────────────────

/**
 * Get all memories linked to a given memory ID.
 * Returns links sorted by similarity (descending), 1 level of depth only.
 */
export async function getLinkedMemories(
  supabase: SupabaseClient | null,
  memoryId: string,
): Promise<LinkedMemory[]> {
  if (!supabase || !memoryId) return [];

  try {
    const { data, error } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: [memoryId],
    });

    if (error) {
      log.error("get_linked_memories error", { error: String(error) });
      return [];
    }

    return (data || []) as LinkedMemory[];
  } catch (error) {
    log.error("get_linked_memories error", { error: String(error) });
    return [];
  }
}

/**
 * Batch fetch linked memories for multiple memory IDs.
 * Returns a Map of origin_id -> linked memories (max 3 per origin).
 * Used by getMemoryContext() to enrich facts/goals with their links.
 */
export async function getLinkedMemoriesBatch(
  supabase: SupabaseClient | null,
  memoryIds: string[],
): Promise<Map<string, LinkedMemory[]>> {
  if (!supabase || memoryIds.length === 0) return new Map();

  try {
    const { data, error } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: memoryIds,
    });

    if (error) {
      log.error("get_linked_memories batch error", { error: String(error) });
      return new Map();
    }

    // Group by origin_id, limit MAX_LINKS_PER_MEMORY_IN_CONTEXT per origin
    const grouped = new Map<string, LinkedMemory[]>();
    for (const link of (data || []) as LinkedMemory[]) {
      const existing = grouped.get(link.origin_id) || [];
      if (existing.length < MAX_LINKS_PER_MEMORY_IN_CONTEXT) {
        existing.push(link);
        grouped.set(link.origin_id, existing);
      }
    }

    return grouped;
  } catch (error) {
    log.error("get_linked_memories batch error", { error: String(error) });
    return new Map();
  }
}

// ── Memory Chains (S41-01) ──────────────────────────────────

/** A node in a multi-hop memory chain (alias for MemoryChain) */
type MemoryChainNode = MemoryChain;

/**
 * Multi-hop BFS traversal of memory links.
 * Starting from a memory ID, follows links up to `maxDepth` levels.
 * Returns all visited nodes with their links and depth info.
 */
export async function getMemoryChain(
  supabase: SupabaseClient | null,
  memoryId: string,
  maxDepth: number = 3,
): Promise<MemoryChainNode[]> {
  if (!supabase || !memoryId) return [];

  try {
    // Fetch the root node
    const { data: rootData } = await supabase
      .from("memory")
      .select("id, content, type")
      .eq("id", memoryId)
      .single();

    if (!rootData) return [];

    const visited = new Map<string, MemoryChainNode>();
    visited.set(memoryId, {
      id: rootData.id,
      content: rootData.content,
      type: rootData.type,
      depth: 0,
      links: [],
    });

    let frontier = [memoryId];
    let depth = 0;

    while (depth < maxDepth && frontier.length > 0 && visited.size < MAX_CHAIN_NODES) {
      const { data: links, error } = await supabase.rpc("get_linked_memories", {
        p_memory_ids: frontier,
      });

      if (error || !links?.length) break;

      const nextFrontier: string[] = [];

      for (const link of links as LinkedMemory[]) {
        // Enrich link type using content heuristic
        const origin = visited.get(link.origin_id);
        const enrichedType = origin
          ? classifyLinkContent(origin.content, link.linked_content)
          : link.link_type;

        // Add link to origin node
        if (origin) {
          origin.links.push({
            targetId: link.linked_id,
            similarity: link.similarity,
            linkType: enrichedType,
          });
        }

        // Add linked node if not visited
        if (!visited.has(link.linked_id) && visited.size < MAX_CHAIN_NODES) {
          visited.set(link.linked_id, {
            id: link.linked_id,
            content: link.linked_content,
            type: link.linked_type,
            depth: depth + 1,
            links: [],
          });
          nextFrontier.push(link.linked_id);
        }
      }

      frontier = nextFrontier;
      depth++;
    }

    return Array.from(visited.values());
  } catch (error) {
    log.error("getMemoryChain error", { error: String(error) });
    return [];
  }
}

// ── Memory Clustering (S41-03) ──────────────────────────────

/**
 * Find connected components in the memory link graph.
 * Fetches top facts and their links, groups into clusters.
 * Only returns clusters with 2+ members. Max 10 clusters.
 */
export async function clusterMemories(
  supabase: SupabaseClient | null,
  maxFacts: number = 50,
  maxClusters: number = 10,
): Promise<MemoryCluster[]> {
  if (!supabase) return [];

  try {
    const { data: facts } = await supabase.rpc("get_facts");
    if (!facts?.length) return [];

    const topFacts = (facts as FactRecord[]).slice(0, maxFacts);
    const factIds = topFacts.map((f) => f.id).filter(Boolean);

    // Fetch all links (use RPC directly to avoid 3-link cap)
    const { data: allLinks } = await supabase.rpc("get_linked_memories", {
      p_memory_ids: factIds,
    });

    // Build adjacency list and node map
    const adj = new Map<string, Set<string>>();
    const nodeMap = new Map<string, { id: string; content: string; type: string }>();

    for (const fact of topFacts) {
      nodeMap.set(fact.id, { id: fact.id, content: fact.content, type: "fact" });
      if (!adj.has(fact.id)) adj.set(fact.id, new Set());
    }

    for (const link of (allLinks || []) as LinkedMemory[]) {
      if (!adj.has(link.origin_id)) adj.set(link.origin_id, new Set());
      adj.get(link.origin_id)!.add(link.linked_id);

      if (!adj.has(link.linked_id)) adj.set(link.linked_id, new Set());
      adj.get(link.linked_id)!.add(link.origin_id);

      if (!nodeMap.has(link.linked_id)) {
        nodeMap.set(link.linked_id, {
          id: link.linked_id,
          content: link.linked_content,
          type: link.linked_type,
        });
      }
    }

    // Find connected components via BFS
    const visited = new Set<string>();
    const clusters: MemoryCluster[] = [];
    let clusterId = 0;

    for (const nodeId of nodeMap.keys()) {
      if (visited.has(nodeId)) continue;

      const component: string[] = [];
      const queue = [nodeId];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);

        for (const neighbor of adj.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      // Only include clusters with 2+ members
      if (component.length >= 2) {
        const memories = component.map((id) => nodeMap.get(id)).filter(Boolean) as Array<{
          id: string;
          content: string;
          type: string;
        }>;

        clusters.push({
          id: clusterId++,
          label: memories[0].content.slice(0, 80),
          memories,
          size: memories.length,
        });
      }
    }

    return clusters.sort((a, b) => b.size - a.size).slice(0, maxClusters);
  } catch (error) {
    log.error("clusterMemories error", { error: String(error) });
    return [];
  }
}

/**
 * Format memory clusters for display (HTML formatting via sendResponseHtml).
 */
export function formatClusters(clusters: MemoryCluster[]): string {
  if (clusters.length === 0) return "Aucun cluster detecte.";

  const lines: string[] = [sectionTitle(`Clusters de memoire (${clusters.length})`), ""];

  for (const cluster of clusters) {
    const clusterItems = cluster.memories
      .slice(0, 5)
      .map((mem) => `  \u2022 [<code>${escapeHtml(mem.type)}</code>] ${escapeHtml(mem.content)}`);
    if (cluster.memories.length > 5) {
      clusterItems.push(`  <i>... et ${cluster.memories.length - 5} autres</i>`);
    }
    const clusterContent = clusterItems.join("\n");

    lines.push(`<b>Cluster ${cluster.id + 1}</b> (${cluster.size} memoires)`);
    lines.push(clusterContent);
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Memory Chains for Agents (S41-04) ───────────────────────

/**
 * Build structured memory chains for agent context.
 * Strategic roles (analyst, pm, architect, qa) get chains with linked context.
 * Tactical roles (dev, sm) get flat facts for efficiency.
 */
export async function buildMemoryChains(
  supabase: SupabaseClient | null,
  role: string,
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const facts = ((factsResult.data || []) as FactRecord[]).slice(0, MAX_FACTS_IN_CONTEXT);
    const goals = ((goalsResult.data || []) as GoalRecord[]).slice(0, MAX_GOALS_IN_CONTEXT);

    // Early return only when BOTH global memory AND role memory are empty (R12)
    const roleMemoryEnabled = isFeatureEnabled("agent_role_memory");
    if (facts.length === 0 && goals.length === 0 && !roleMemoryEnabled) return "";

    // Fetch links for all memories (only when there are global memories to link)
    const allIds = [...facts.map((f) => f.id), ...goals.map((g) => g.id)].filter(Boolean);
    const linkedMap =
      allIds.length > 0 ? await getLinkedMemoriesBatch(supabase, allIds) : new Map();

    const parts: string[] = [];
    const servedIds: string[] = [];

    if (role === "dev" || role === "sm") {
      // Tactical roles: flat facts
      if (facts.length) {
        parts.push(
          "Faits cles:\n" +
            facts
              .slice(0, 10)
              .map((f) => `- ${f.content}`)
              .join("\n"),
        );
        servedIds.push(...facts.slice(0, 10).map((f) => f.id));
      }
      if (goals.length) {
        parts.push(
          "Objectifs:\n" +
            goals
              .slice(0, 5)
              .map((g) => `- ${g.content}`)
              .join("\n"),
        );
        servedIds.push(...goals.slice(0, 5).map((g) => g.id));
      }
    } else {
      // Strategic roles: structured chains
      const usedInChain = new Set<string>();
      const chains: string[] = [];

      for (const fact of facts) {
        if (usedInChain.has(fact.id)) continue;
        servedIds.push(fact.id);
        usedInChain.add(fact.id);

        const links = linkedMap.get(fact.id) || [];
        if (links.length > 0) {
          const chainLines = [`- ${fact.content}`];
          for (const link of links) {
            const enrichedType = classifyLinkContent(fact.content, link.linked_content);
            chainLines.push(`  [${enrichedType}] ${link.linked_content}`);
            usedInChain.add(link.linked_id);
          }
          chains.push(chainLines.join("\n"));
        } else {
          chains.push(`- ${fact.content}`);
        }
      }

      if (chains.length) {
        parts.push("Faits et chaines:\n" + chains.join("\n"));
      }

      // Goals with linked context
      if (goals.length) {
        const goalLines = goals.map((g) => {
          const deadline = g.deadline
            ? ` (echeance: ${new Date(g.deadline).toLocaleDateString("fr-FR")})`
            : "";
          const links = linkedMap.get(g.id) || [];
          servedIds.push(g.id);
          if (links.length > 0) {
            const linkLines = links.map(
              (l: LinkedMemory) =>
                `  [${classifyLinkContent(g.content, l.linked_content)}] ${l.linked_content}`,
            );
            return [`- ${g.content}${deadline}`, ...linkLines].join("\n");
          }
          return `- ${g.content}${deadline}`;
        });
        parts.push("Objectifs et contexte:\n" + goalLines.join("\n"));
      }
    }

    // Bump access (fire and forget)
    if (servedIds.length > 0) {
      bumpMemoryAccess(supabase, servedIds).catch(() => {});
    }

    // R12 / V4 / V5 / V6: inject MEMOIRE ROLE section when feature flag enabled
    if (roleMemoryEnabled) {
      const roleMemories = await getAgentMemories(supabase, role, AGENT_MEMORY_HARD_LIMIT);
      if (roleMemories.length > 0) {
        // V5: format plat pour tous les roles en V1 (liens inter-memoires reportes V2)
        const roleParts = roleMemories.map((m) => {
          const tagsStr = m.tags?.length ? ` [tags: ${m.tags.join(", ")}]` : "";
          return `- ${m.content}${tagsStr}`;
        });
        parts.push(`MEMOIRE ROLE (${role}):\n${roleParts.join("\n")}`);
      }
    }

    if (parts.length === 0) return "";
    return parts.join("\n\n");
  } catch (error) {
    log.error("buildMemoryChains error", { error: String(error) });
    return "";
  }
}

// ── Memory Health Stats ─────────────────────────────────────

/**
 * Compute quantitative health metrics for the memory system.
 * All queries run in parallel for performance (< 2s target).
 * Returns safe defaults (0) when supabase is null or table is empty (R13).
 */
export async function memoryHealthStats(
  supabase: SupabaseClient | null,
): Promise<MemoryHealthStats> {
  const empty: MemoryHealthStats = {
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

  if (!supabase) return empty;

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      allMemories,
      withEmbedding,
      linksResult,
      archiveResult,
      topAccessedResult,
      recentPromotionsResult,
    ] = await Promise.all([
      // All active memories with type, importance_score, created_at
      supabase.from("memory").select("type, importance_score, created_at, access_count"),
      // Count memories with non-null embedding
      supabase.from("memory").select("id").not("embedding", "is", null),
      // Total links
      supabase.from("memory_links").select("id"),
      // Total archived
      supabase.from("memory_archive").select("id"),
      // Top 5 most accessed
      supabase
        .from("memory")
        .select("content, access_count")
        .order("access_count", { ascending: false })
        .limit(5),
      // Recent promotions (7 days, inserts only — R14 limitation)
      supabase
        .from("memory")
        .select("id")
        .eq("metadata->>source", "working_memory_promotion")
        .gte("created_at", sevenDaysAgo),
    ]);

    const memories = allMemories.data || [];
    const total = memories.length;

    if (total === 0) return empty;

    // By type
    const byType: Record<string, number> = {};
    let totalImportance = 0;
    let totalAgeDays = 0;
    const now = Date.now();

    for (const m of memories) {
      byType[m.type] = (byType[m.type] || 0) + 1;
      totalImportance += m.importance_score ?? 0;
      const created = new Date(m.created_at).getTime();
      totalAgeDays += (now - created) / (1000 * 60 * 60 * 24);
    }

    const embeddingCount = withEmbedding.data?.length || 0;

    return {
      total,
      byType,
      embeddingCoverage: total > 0 ? embeddingCount / total : 0,
      avgImportanceScore: total > 0 ? Math.round((totalImportance / total) * 10) / 10 : 0,
      avgAgeDays: total > 0 ? Math.round((totalAgeDays / total) * 10) / 10 : 0,
      recentPromotions: recentPromotionsResult.data?.length || 0,
      linksCount: linksResult.data?.length || 0,
      archiveCount: archiveResult.data?.length || 0,
      topAccessed: (topAccessedResult.data || [])
        .filter((r: { access_count: number; content: string }) => r.access_count > 0)
        .map((r: { access_count: number; content: string }) => ({
          content: r.content,
          accessCount: r.access_count,
        })),
    };
  } catch (error) {
    log.error("memoryHealthStats error", { error: String(error) });
    return empty;
  }
}

/**
 * Format memory health stats for Telegram (HTML formatting via sendResponseHtml).
 */
export function formatMemoryHealth(stats: MemoryHealthStats): string {
  const lines: string[] = [];
  lines.push(sectionTitle("Sante memoire"));
  lines.push("");
  lines.push(kvLine("Total", `${stats.total} memoires actives`));

  if (Object.keys(stats.byType).length > 0) {
    const types = Object.entries(stats.byType)
      .map(([t, c]) => `<code>${escapeHtml(t)}</code>: ${c}`)
      .join(" | ");
    lines.push(`  ${types}`);
  }

  const embCount = Math.round(stats.embeddingCoverage * stats.total);
  lines.push("");
  lines.push(separator());
  lines.push(`<b>Embeddings</b>  ${progressBar(embCount, stats.total)}`);
  lines.push(kvLine("Importance moyenne", stats.avgImportanceScore));
  lines.push(kvLine("Age moyen", `${stats.avgAgeDays} jours`));
  lines.push(kvLine("Liens semantiques", stats.linksCount));
  lines.push(kvLine("Archive", stats.archiveCount));
  lines.push(kvLine("Promotions recentes (7j)", stats.recentPromotions));

  if (stats.topAccessed.length > 0) {
    lines.push("");
    lines.push(separator());
    lines.push("<b>Top acces</b>");
    for (const t of stats.topAccessed) {
      const truncated = t.content.slice(0, 40) + (t.content.length > 40 ? "..." : "");
      lines.push(`  \u2022 "${escapeHtml(truncated)}" (${t.accessCount}x)`);
    }
  }

  return lines.join("\n");
}

// ── Similar Past Tasks (S41-05) ─────────────────────────────

/**
 * Find completed tasks similar to a given title using keyword matching.
 * Returns historical data: estimated vs actual hours, sprint, tags.
 * Used by agents to calibrate effort estimation.
 */
export async function findSimilarPastTasks(
  supabase: SupabaseClient | null,
  taskTitle: string,
  limit: number = 5,
): Promise<SimilarTask[]> {
  if (!supabase || !taskTitle) return [];

  try {
    // Extract keywords (words with 4+ chars)
    const keywords = taskTitle
      .toLowerCase()
      .split(/[\s\-_:]+/)
      .filter((w) => w.length >= 4)
      .slice(0, 3);

    if (keywords.length === 0) return [];

    // Search done tasks with matching keywords
    const filters = keywords.map((k) => `title.ilike.%${k}%`);

    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, estimated_hours, actual_hours, sprint, tags")
      .eq("status", "done")
      .or(filters.join(","))
      .order("completed_at", { ascending: false })
      .limit(limit);

    if (error || !data?.length) return [];

    return data.map(
      (t: {
        id: string;
        title: string;
        estimated_hours: number | null;
        actual_hours: number | null;
        sprint: string | null;
        tags: string[] | null;
      }) => ({
        id: t.id,
        title: t.title,
        estimatedHours: t.estimated_hours,
        actualHours: t.actual_hours,
        sprint: t.sprint,
        tags: t.tags || [],
      }),
    );
  } catch (error) {
    log.error("findSimilarPastTasks error", { error: String(error) });
    return [];
  }
}
