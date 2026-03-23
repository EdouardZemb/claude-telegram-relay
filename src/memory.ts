/**
 * @module memory
 * @description Barrel re-export for memory sub-modules.
 * Intelligent memory: intent tags, auto-classification, semantic archive,
 * ideas pipeline, importance scoring with temporal decay, contradiction detection.
 */

// ── agent-memory.ts ──────────────────────────────────────────
export {
  type AgentMemoryRecord,
  getAgentMemories,
  graduateAgentMemory,
  normalizeContent,
  ROLE_CANONICAL_TAGS,
  resolveAgentMemoryConflict,
  saveAgentMemory,
} from "./memory/agent-memory.ts";

// ── classification.ts ────────────────────────────────────────
export {
  autoRemember,
  classifyLinkContent,
  classifyMessage,
  findDuplicateIdea,
  type ThoughtClassification,
} from "./memory/classification.ts";
// ── core.ts ──────────────────────────────────────────────────
export {
  archiveOldMemories,
  getMemoryContext,
  getRecentMessages,
  getRelevantContext,
  processMemoryIntents,
} from "./memory/core.ts";
// ── graph.ts ─────────────────────────────────────────────────
export {
  AGENT_MEMORY_HARD_LIMIT,
  buildMemoryChains,
  clusterMemories,
  findSimilarPastTasks,
  formatClusters,
  formatMemoryHealth,
  getLinkedMemories,
  getLinkedMemoriesBatch,
  getMemoryChain,
  type LinkedMemory,
  linkMemories,
  type MemoryChain,
  type MemoryCluster,
  type MemoryHealthStats,
  memoryHealthStats,
  promoteWorkingMemory,
  type SimilarTask,
  type WorkingMemoryData,
} from "./memory/graph.ts";
// ── ideas.ts ─────────────────────────────────────────────────
export {
  archiveIdea,
  formatIdeasList,
  getIdea,
  type Idea,
  listIdeas,
  promoteIdea,
  reviewIdea,
} from "./memory/ideas.ts";
// ── scoring.ts ───────────────────────────────────────────────
export {
  bumpMemoryAccess,
  type ConflictResolution,
  calculateEffectiveImportance,
  detectAndLogContradiction,
  findContradiction,
  findSimilarFact,
  PROMOTION_MAX_CHARS,
  resolveMemoryConflict,
  updateMemoryWithRevision,
} from "./memory/scoring.ts";
