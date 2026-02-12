/**
 * Document Sharding System
 *
 * Splits large documents (PRDs, architecture docs) into indexed sections.
 * Each shard is stored separately with metadata for efficient retrieval.
 * Only relevant shards are loaded into context, saving tokens.
 *
 * S15-01: Document Sharding
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────

export type DocumentType = "prd" | "architecture" | "story" | "research" | "memory" | "retro" | "analysis";

export interface DocumentShard {
  id: string;
  document_id: string;
  document_type: DocumentType;
  section_title: string;
  section_index: number;
  content: string;
  token_estimate: number;
  refs: string[]; // cross-references to other shard IDs
  project_id: string | null;
  created_at: string;
}

export interface ShardedDocument {
  id: string;
  title: string;
  type: DocumentType;
  total_shards: number;
  total_tokens: number;
  sections: string[]; // ordered list of section titles
  project_id: string | null;
}

interface Section {
  title: string;
  content: string;
  level: number;
}

// ── Context Cache ────────────────────────────────────────────

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const contextCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 50;

function getCached(key: string): string | null {
  const entry = contextCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    contextCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key: string, value: string): void {
  // Evict oldest entries if cache is full
  if (contextCache.size >= CACHE_MAX_SIZE) {
    const oldest = [...contextCache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) contextCache.delete(oldest[0]);
  }
  contextCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Clear cache entries for a specific project (call after document updates) */
export function invalidateProjectCache(projectId: string): void {
  for (const [key] of contextCache) {
    if (key.startsWith(`ctx:${projectId}:`)) {
      contextCache.delete(key);
    }
  }
}

/** Clear all cache */
export function clearContextCache(): void {
  contextCache.clear();
}

// ── Sharding Logic ───────────────────────────────────────────

/**
 * Estimate token count for a string (rough: 1 token ~= 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split a markdown document into sections based on headings.
 * Each ## heading becomes a new section. Content before the first heading
 * goes into a "Preamble" section.
 */
export function splitIntoSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentTitle = "Preambule";
  let currentLevel = 0;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      // Save previous section if it has content
      const prevContent = currentLines.join("\n").trim();
      if (prevContent) {
        sections.push({
          title: currentTitle,
          content: prevContent,
          level: currentLevel,
        });
      }
      currentTitle = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Save last section
  const lastContent = currentLines.join("\n").trim();
  if (lastContent) {
    sections.push({
      title: currentTitle,
      content: lastContent,
      level: currentLevel,
    });
  }

  return sections;
}

/**
 * Extract cross-references from a section's content.
 * Looks for patterns like "voir section X", "cf. X", "ref: X".
 */
function extractRefs(content: string, allSections: Section[]): string[] {
  const refs: string[] = [];
  const sectionTitles = allSections.map((s) => s.title.toLowerCase());

  for (const section of allSections) {
    const titleLower = section.title.toLowerCase();
    // Check if this section is referenced in the content
    if (
      content.toLowerCase().includes(titleLower) &&
      !content.toLowerCase().startsWith(`# ${titleLower}`) &&
      !content.toLowerCase().startsWith(`## ${titleLower}`)
    ) {
      // Only add if it's actually a reference, not the section itself
      const idx = sectionTitles.indexOf(titleLower);
      if (idx !== -1) {
        refs.push(section.title);
      }
    }
  }

  return refs;
}

// ── Database Operations ──────────────────────────────────────

/**
 * Shard a document and store all shards in Supabase.
 * Returns the sharded document metadata.
 */
export async function shardDocument(
  supabase: SupabaseClient,
  doc: {
    id: string;
    title: string;
    content: string;
    type: DocumentType;
    project_id?: string | null;
  }
): Promise<ShardedDocument | null> {
  const sections = splitIntoSections(doc.content);
  if (sections.length === 0) return null;

  // Extract refs for each section
  const shardsToInsert = sections.map((section, index) => ({
    document_id: doc.id,
    document_type: doc.type,
    section_title: section.title,
    section_index: index,
    content: section.content,
    token_estimate: estimateTokens(section.content),
    refs: extractRefs(section.content, sections),
    project_id: doc.project_id ?? null,
  }));

  // Delete existing shards for this document (re-sharding)
  await supabase
    .from("document_shards")
    .delete()
    .eq("document_id", doc.id);

  // Insert new shards
  const { error } = await supabase
    .from("document_shards")
    .insert(shardsToInsert);

  if (error) {
    console.error("shardDocument error:", error);
    return null;
  }

  // Invalidate cache for this project since document content changed
  if (doc.project_id) {
    invalidateProjectCache(doc.project_id);
  }

  const totalTokens = shardsToInsert.reduce(
    (sum, s) => sum + s.token_estimate,
    0
  );

  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    total_shards: sections.length,
    total_tokens: totalTokens,
    sections: sections.map((s) => s.title),
    project_id: doc.project_id ?? null,
  };
}

/**
 * Get all shards for a document.
 */
export async function getDocumentShards(
  supabase: SupabaseClient,
  documentId: string
): Promise<DocumentShard[]> {
  const { data, error } = await supabase
    .from("document_shards")
    .select("*")
    .eq("document_id", documentId)
    .order("section_index", { ascending: true });

  if (error) {
    console.error("getDocumentShards error:", error);
    return [];
  }
  return (data ?? []) as DocumentShard[];
}

/**
 * Get specific shards by section titles.
 * Used to load only relevant sections into context.
 */
export async function getShardsByTitle(
  supabase: SupabaseClient,
  documentId: string,
  sectionTitles: string[]
): Promise<DocumentShard[]> {
  const { data, error } = await supabase
    .from("document_shards")
    .select("*")
    .eq("document_id", documentId)
    .in("section_title", sectionTitles)
    .order("section_index", { ascending: true });

  if (error) {
    console.error("getShardsByTitle error:", error);
    return [];
  }
  return (data ?? []) as DocumentShard[];
}

/**
 * Get the table of contents (sections list) for a document
 * without loading full content. Lightweight for context selection.
 */
export async function getDocumentTOC(
  supabase: SupabaseClient,
  documentId: string
): Promise<Array<{ title: string; index: number; tokens: number }>> {
  const { data, error } = await supabase
    .from("document_shards")
    .select("section_title, section_index, token_estimate")
    .eq("document_id", documentId)
    .order("section_index", { ascending: true });

  if (error) {
    console.error("getDocumentTOC error:", error);
    return [];
  }
  return (data ?? []).map(
    (d: { section_title: string; section_index: number; token_estimate: number }) => ({
      title: d.section_title,
      index: d.section_index,
      tokens: d.token_estimate,
    })
  );
}

/**
 * Get shards that fit within a token budget.
 * Prioritizes sections by relevance to a query.
 */
export async function getRelevantShards(
  supabase: SupabaseClient,
  documentId: string,
  query: string,
  tokenBudget: number = 2000
): Promise<DocumentShard[]> {
  const allShards = await getDocumentShards(supabase, documentId);
  if (allShards.length === 0) return [];

  // Score each shard by keyword overlap with query
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = allShards.map((shard) => {
    const contentLower = shard.content.toLowerCase();
    const titleLower = shard.section_title.toLowerCase();
    let score = 0;

    for (const word of queryWords) {
      if (titleLower.includes(word)) score += 3;
      if (contentLower.includes(word)) score += 1;
    }

    // Boost first section (usually contains overview)
    if (shard.section_index === 0) score += 2;

    return { shard, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Pick shards within budget
  const result: DocumentShard[] = [];
  let usedTokens = 0;

  for (const { shard } of scored) {
    if (usedTokens + shard.token_estimate > tokenBudget) continue;
    result.push(shard);
    usedTokens += shard.token_estimate;
  }

  // Re-sort by section index for reading order
  result.sort((a, b) => a.section_index - b.section_index);
  return result;
}

/**
 * Build a context string from shards, with section markers.
 */
export function buildShardedContext(
  shards: DocumentShard[],
  docTitle: string
): string {
  if (shards.length === 0) return "";

  const parts = [`DOCUMENT: ${docTitle}`, ""];

  for (const shard of shards) {
    parts.push(`--- ${shard.section_title} (section ${shard.section_index + 1}) ---`);
    parts.push(shard.content);
    parts.push("");
  }

  return parts.join("\n").trim();
}

// ── Cross-References ─────────────────────────────────────────

/**
 * Resolve cross-references: given a shard, find all related shards
 * from the same document or from other documents in the same project.
 */
export async function resolveShardRefs(
  supabase: SupabaseClient,
  shard: DocumentShard
): Promise<DocumentShard[]> {
  if (shard.refs.length === 0) return [];

  // First, check same document
  const sameDoc = await getShardsByTitle(
    supabase,
    shard.document_id,
    shard.refs
  );

  return sameDoc;
}

/**
 * Find related documents in the same project.
 * Returns shards from OTHER documents that reference similar sections.
 */
export async function findRelatedDocuments(
  supabase: SupabaseClient,
  documentId: string,
  projectId: string
): Promise<Array<{ document_id: string; document_type: string; section_title: string; overlap_score: number }>> {
  // Get this document's section titles
  const toc = await getDocumentTOC(supabase, documentId);
  const titles = toc.map((t) => t.title.toLowerCase());

  // Get all shards from other documents in the same project
  const { data, error } = await supabase
    .from("document_shards")
    .select("document_id, document_type, section_title, refs")
    .eq("project_id", projectId)
    .neq("document_id", documentId);

  if (error || !data) return [];

  // Score by overlap: shards that reference sections from our document
  const scored = new Map<string, { document_id: string; document_type: string; section_title: string; overlap_score: number }>();

  for (const row of data as Array<{ document_id: string; document_type: string; section_title: string; refs: string[] }>) {
    const refs = row.refs || [];
    let score = 0;

    for (const ref of refs) {
      if (titles.includes(ref.toLowerCase())) score++;
    }

    // Also check if section title overlaps
    if (titles.includes(row.section_title.toLowerCase())) score += 2;

    if (score > 0) {
      const key = `${row.document_id}:${row.section_title}`;
      scored.set(key, {
        document_id: row.document_id,
        document_type: row.document_type,
        section_title: row.section_title,
        overlap_score: score,
      });
    }
  }

  return Array.from(scored.values()).sort((a, b) => b.overlap_score - a.overlap_score);
}

/**
 * Build enriched context for a task execution.
 * Combines relevant PRD shards + related architecture shards.
 */
export async function buildTaskContext(
  supabase: SupabaseClient,
  taskTitle: string,
  projectId: string,
  tokenBudget: number = 3000
): Promise<string> {
  // Check cache first
  const cacheKey = `ctx:${projectId}:${taskTitle.substring(0, 50)}:${tokenBudget}`;
  const cached = getCached(cacheKey);
  if (cached !== null) return cached;

  // Find all sharded documents for this project
  const { data: allShards } = await supabase
    .from("document_shards")
    .select("document_id, document_type")
    .eq("project_id", projectId);

  if (!allShards || allShards.length === 0) return "";

  // Deduplicate document IDs
  const docIds = [...new Set((allShards as Array<{ document_id: string; document_type: string }>).map((s) => s.document_id))];

  // Get relevant shards from each document
  const contextParts: string[] = [];
  let remainingBudget = tokenBudget;

  for (const docId of docIds) {
    if (remainingBudget <= 200) break;

    const shards = await getRelevantShards(supabase, docId, taskTitle, remainingBudget);
    if (shards.length > 0) {
      const docType = (allShards as Array<{ document_id: string; document_type: string }>)
        .find((s) => s.document_id === docId)?.document_type || "document";
      const context = buildShardedContext(shards, `${docType.toUpperCase()} ${docId.substring(0, 8)}`);
      contextParts.push(context);
      remainingBudget -= shards.reduce((sum, s) => sum + s.token_estimate, 0);
    }
  }

  const result = contextParts.join("\n\n");
  setCache(cacheKey, result);
  return result;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format a document's shard overview for display.
 */
export function formatShardOverview(doc: ShardedDocument): string {
  const lines = [
    `${doc.title} (${doc.type.toUpperCase()})`,
    `${doc.total_shards} sections | ~${doc.total_tokens} tokens`,
    "",
    "Sections:",
  ];

  for (let i = 0; i < doc.sections.length; i++) {
    lines.push(`  ${i + 1}. ${doc.sections[i]}`);
  }

  return lines.join("\n");
}

/**
 * Format cross-references for display.
 */
export function formatCrossRefs(
  refs: Array<{ document_id: string; document_type: string; section_title: string; overlap_score: number }>
): string {
  if (refs.length === 0) return "Aucune reference croisee trouvee.";

  const lines = ["References croisees:", ""];
  for (const ref of refs.slice(0, 10)) {
    lines.push(`  ${ref.document_type.toUpperCase()} [${ref.document_id.substring(0, 8)}] > ${ref.section_title} (score: ${ref.overlap_score})`);
  }
  return lines.join("\n");
}

// ── Extended Sharding: Memory & Research (S16-08) ─────────────

/**
 * Shard a retro into indexed sections for efficient retrieval.
 * Creates sections: what_worked, what_didnt, patterns, actions.
 */
export async function shardRetro(
  supabase: SupabaseClient,
  retro: {
    sprint_id: string;
    what_worked: string[];
    what_didnt: string[];
    patterns_detected: string[];
    actions_proposed?: Array<{ action: string; priority: string }>;
    raw_analysis?: string;
  },
  projectId?: string
): Promise<ShardedDocument | null> {
  const sections: string[] = [];

  if (retro.what_worked?.length > 0) {
    sections.push(`## Ce qui a bien marche\n${retro.what_worked.map((w) => `- ${w}`).join("\n")}`);
  }
  if (retro.what_didnt?.length > 0) {
    sections.push(`## Ce qui a coince\n${retro.what_didnt.map((w) => `- ${w}`).join("\n")}`);
  }
  if (retro.patterns_detected?.length > 0) {
    sections.push(`## Patterns detectes\n${retro.patterns_detected.map((p) => `- ${p}`).join("\n")}`);
  }
  if (retro.actions_proposed?.length) {
    sections.push(`## Actions proposees\n${retro.actions_proposed.map((a) => `- [${a.priority}] ${a.action}`).join("\n")}`);
  }
  if (retro.raw_analysis) {
    sections.push(`## Analyse detaillee\n${retro.raw_analysis}`);
  }

  const content = `# Retro ${retro.sprint_id}\n\n${sections.join("\n\n")}`;

  return shardDocument(supabase, {
    id: `retro-${retro.sprint_id}`,
    title: `Retro Sprint ${retro.sprint_id}`,
    content,
    type: "retro",
    project_id: projectId,
  });
}

/**
 * Shard memory facts into searchable sections.
 * Groups facts by category for efficient context loading.
 */
export async function shardMemoryFacts(
  supabase: SupabaseClient,
  facts: Array<{ content: string; category?: string }>,
  projectId?: string
): Promise<ShardedDocument | null> {
  if (facts.length === 0) return null;

  // Group by category
  const groups: Record<string, string[]> = {};
  for (const fact of facts) {
    const cat = fact.category || "general";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(fact.content);
  }

  const sections = Object.entries(groups)
    .map(([cat, items]) => `## ${cat}\n${items.map((i) => `- ${i}`).join("\n")}`)
    .join("\n\n");

  const content = `# Memory Facts\n\n${sections}`;

  return shardDocument(supabase, {
    id: `memory-facts-${projectId || "global"}`,
    title: "Memory Facts",
    content,
    type: "memory",
    project_id: projectId,
  });
}

/**
 * Shard an analysis output (from /patterns or agent analysis).
 */
export async function shardAnalysis(
  supabase: SupabaseClient,
  analysis: {
    id: string;
    title: string;
    content: string;
    projectId?: string;
  }
): Promise<ShardedDocument | null> {
  return shardDocument(supabase, {
    id: analysis.id,
    title: analysis.title,
    content: analysis.content,
    type: "analysis",
    project_id: analysis.projectId,
  });
}
