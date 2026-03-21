/**
 * @module orchestrator
 * @description Multi-agent pipeline: structured JSON message passing, retry loop,
 * dynamic pipeline selection, cost tracking per agent, blackboard integration.
 */

/**
 * Multi-Agent Orchestrator — S16-01 / S22
 *
 * Chains BMad agents in configurable sequences.
 * S22: Structured message passing (JSON schemas), retry loop,
 *      dynamic pipeline selection.
 *
 * Usage:
 *   const result = await orchestrate(supabase, task, {
 *     pipeline: ["analyst", "pm", "architect", "dev", "qa"],
 *     onProgress: async (msg) => ctx.reply(msg),
 *   });
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "./tasks.ts";
import { buildStoryFile, enrichTaskWithStory } from "./story-files.ts";
import {
  buildFullAgentPrompt,
  buildIsolationInstructions,
  loadAgentYaml,
  type AgentPromptContext,
} from "./bmad-prompts.ts";
import { getAgent, type BmadAgent } from "./bmad-agents.ts";
import { spawnClaude } from "./agent.ts";
import { WorkflowTracker } from "./workflow.ts";
import { buildTaskContext } from "./document-sharding.ts";
import {
  type AgentMessage,
  type StructuredAgentOutput,
  parseAgentOutput,
  buildStructuredOutputInstructions,
  buildStructuredChainContext,
  getJsonSchemaForRole,
  formatStructuredOutput,
  parseExplorationPhaseOutput,
  formatExplorationPhaseOutput,
} from "./agent-schemas.ts";
import { parseTokenUsage, logCost, estimateCost } from "./cost-tracking.ts";
import { logCostWithSpan, buildSpanId, recordPromptVersion, sha256 } from "./llm-ops.ts";
import { getFeedbackRulesForAgent } from "./feedback-loop.ts";
import {
  createBlackboard,
  readSection,
  writeSection,
  getFullBlackboard,
  updateBlackboardStatus,
  generateTraceabilityReport,
  formatTraceabilityReport,
  InMemoryBlackboard,
  type BlackboardRow,
  type SectionName,
  type WorkingMemory,
} from "./blackboard.ts";
import {
  evaluateAndRework,
  type GateName,
  type GateEvaluation,
} from "./gate-evaluator.ts";
import {
  verifySpecVsImplementation,
  persistDriftReport,
  formatDriftReport,
  type DriftReport,
} from "./adversarial-verifier.ts";
import { readFileSync } from "fs";
import { join } from "path";
import { writeSectionWithRetry } from "./blackboard.ts";
import { buildAgentContext } from "./agent-context.ts";
import {
  createPipelineRun,
  savePipelineStep,
  updatePipelineStatus,
  loadPipelineState,
  buildResumeContext,
  findLatestPipelineRun,
  type StepSnapshot,
} from "./pipeline-state.ts";
import { emitAgentEvent, clearInMemoryEvents, captureAgentFailure } from "./agent-events.ts";
import {
  getAgentMessages,
  checkPendingClarifications,
  detectConflicts,
  getMediatingAgent,
  sendAgentMessage,
  buildInterAgentContext,
  clearClarificationTracker,
  canRequestClarification,
  markClarificationUsed,
  type AgentInterMessage,
} from "./agent-messaging.ts";
import {
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  LIGHT_PIPELINE,
  RESEARCH_PIPELINE,
  selectPipeline,
  selectAdaptivePipeline,
  classifyPipeline,
  classifyAdaptivePipeline,
  type PipelineType,
} from "./pipeline-selection.ts";
import {
  shouldDeliberate,
  getDeliberationReviewer,
  runDeliberation,
} from "./deliberation.ts";
import {
  shouldExplore,
  type ExplorationScore,
} from "./exploration-scoring.ts";

// Re-export pipeline selection for backward compatibility
export {
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  LIGHT_PIPELINE,
  RESEARCH_PIPELINE,
  selectPipeline,
  selectAdaptivePipeline,
  classifyPipeline,
  classifyAdaptivePipeline,
  type PipelineType,
};

// Re-export deliberation protocol for backward compatibility
export { runDeliberation, shouldDeliberate, getDeliberationReviewer } from "./deliberation.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── Types ────────────────────────────────────────────────────

export type AgentRole = "analyst" | "pm" | "architect" | "dev" | "qa" | "sm" | "explorer" | "planner";

export interface AgentStepResult {
  agentId: AgentRole;
  agentName: string;
  success: boolean;
  output: string;
  structured: StructuredAgentOutput | null;
  error?: string;
  durationMs: number;
  retryCount?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
}

export interface OrchestratedResult {
  success: boolean;
  steps: AgentStepResult[];
  totalDurationMs: number;
  summary: string;
  /** S24: Blackboard data (only present when useBlackboard=true) */
  blackboard?: {
    sessionId: string;
    gateEvaluations: GateEvaluation[];
    driftReport: DriftReport | null;
    traceabilityReport: ReturnType<typeof generateTraceabilityReport> | null;
  };
}

/** Maps agent roles to the workflow command they execute */
const AGENT_COMMAND_MAP: Record<AgentRole, string> = {
  analyst: "patterns",
  pm: "plan",
  architect: "architecture",
  dev: "exec",
  qa: "alerts",
  sm: "sprint",
  explorer: "explore",
  planner: "plan",
};

// ── Core Orchestrator ────────────────────────────────────────

/**
 * Run a single agent step: build prompt, call Claude, return result.
 * S22: Uses structured output instructions and parses JSON from output.
 */
export async function runAgentStep(
  agentId: AgentRole,
  task: Task,
  previousMessages: AgentMessage[],
  shardedContext?: string,
  agentContext?: string,
  /** S34: Per-role model override from LLM router */
  modelOverride?: string,
  /** S34: Enable model cascade */
  cascade?: boolean
): Promise<AgentStepResult> {
  const startTime = Date.now();
  const agent = getAgent(agentId);
  const agentName = agent?.name || agentId;

  const command = AGENT_COMMAND_MAP[agentId] || agentId;

  const context: AgentPromptContext = {
    command,
    taskTitle: task.title,
    taskDescription: task.description || undefined,
    priority: task.priority,
    acceptanceCriteria: task.acceptance_criteria || undefined,
    devNotes: task.dev_notes || undefined,
    architectureRef: task.architecture_ref || undefined,
    projectName: task.project,
    sprintId: task.sprint || undefined,
    subtasks: task.subtasks?.map((st: any) => ({
      title: st.title,
      done: st.done,
    })) || undefined,
    shardedContext: shardedContext || undefined,
  };

  // Build prompt
  let prompt = buildFullAgentPrompt(agentId, context);
  const isolation = buildIsolationInstructions(agentId);
  prompt = `${prompt}\n\n${isolation}`;

  // Add structured output instructions (S22-03)
  prompt += buildStructuredOutputInstructions(agentId);

  // Add structured chain context from previous agents (S22-01/02)
  if (previousMessages.length > 0) {
    prompt += `\n\n---\n\n${buildStructuredChainContext(previousMessages)}`;
  }

  // Specific instructions per role in orchestration
  prompt += getOrchestrationInstructions(agentId);

  try {
    // S28: Use centralized spawnClaude with agent-specific CLI flags
    // S32: Inject Supabase context via --append-system-prompt
    // S33: MCP tool instructions per role
    // S34: Model override from router (AC-019), cascade support
    const jsonSchema = getJsonSchemaForRole(agentId);
    const effectiveModel = modelOverride || agent?.model;
    const result = await spawnClaude({
      prompt,
      systemPrompt: agentContext || undefined,
      outputFormat: jsonSchema ? "json" : "text",
      jsonSchema: jsonSchema || undefined,
      effort: agent?.effort,
      model: cascade ? undefined : effectiveModel, // cascade handles model selection
      fallbackModel: cascade ? undefined : agent?.fallbackModel,
      // Budget limits removed — agents run unconstrained
      mcpRole: agentId,
      cascade,
    });

    const rawOutput = result.stdout;
    const success = result.exitCode === 0;

    // Parse structured output (S22-02)
    const structured = success ? parseAgentOutput(rawOutput, agentId) : null;

    // Parse token usage (S23-05, S28: model-aware pricing, S34: cascade model tracking)
    const actualModel = result.modelUsed || effectiveModel || agent?.model;
    const usage = parseTokenUsage(rawOutput, prompt.length, actualModel);

    return {
      agentId,
      agentName,
      success,
      output: rawOutput,
      structured,
      error: result.exitCode !== 0 ? result.stderr : undefined,
      durationMs: Date.now() - startTime,
      tokensInput: usage.tokensInput,
      tokensOutput: usage.tokensOutput,
      costUsd: usage.costUsd,
    };
  } catch (error) {
    return {
      agentId,
      agentName,
      success: false,
      output: "",
      structured: null,
      error: String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Get orchestration-specific instructions for each agent in a pipeline.
 */
function getOrchestrationInstructions(agentId: AgentRole): string {
  switch (agentId) {
    case "analyst":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Analyst):",
        "- Analyse la faisabilite et les risques de la tache",
        "- Identifie les dependances et les points d'attention",
        "- Fournis un brief concis (max 500 mots) pour les agents suivants",
        "- Format: ANALYSE, RISQUES, RECOMMANDATIONS",
      ].join("\n");

    case "pm":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (PM):",
        "- Decompose la tache en sous-taches atomiques si necessaire",
        "- Definis les criteres d'acceptation precis",
        "- Priorise les sous-taches par dependance logique",
        "- Format: SOUS-TACHES (liste), CRITERES D'ACCEPTATION, PRIORITES",
      ].join("\n");

    case "architect":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Architect):",
        "- Valide la faisabilite technique",
        "- Propose l'architecture / le design si necessaire",
        "- Identifie les fichiers a modifier et les patterns a suivre",
        "- Format: DESIGN, FICHIERS IMPACTES, PATTERNS, RISQUES TECHNIQUES",
      ].join("\n");

    case "dev":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (Dev):",
        "- Implemente selon les specs des agents precedents",
        "- Respecte l'architecture proposee",
        "- Ecris les tests pour chaque modification",
        "- Fais un resume des fichiers modifies a la fin",
      ].join("\n");

    case "qa":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (QA):",
        "- Review le travail du Dev agent",
        "- Verifie l'alignement avec les specs PM et l'architecture",
        "- Identifie les tests manquants",
        "- Score de qualite 0-100 et findings",
        "- Format JSON: {score, findings: [{severity, description, suggestion}], summary}",
      ].join("\n");

    case "sm":
      return [
        "",
        "",
        "INSTRUCTIONS ORCHESTRATION (SM):",
        "- Synthetise le resultat global de l'orchestration",
        "- Identifie les points de suivi",
        "- Propose les prochaines etapes",
      ].join("\n");

    default:
      return "";
  }
}

// ── S43: Deliberation Protocol (extracted to src/deliberation.ts) ──

/**
 * Persist agent output as a structured artifact on the task.
 * PM → acceptance_criteria, Architect → architecture_ref, QA → dev_notes append
 */
async function persistAgentArtifact(
  supabase: SupabaseClient,
  taskId: string,
  agentId: AgentRole,
  output: string
): Promise<void> {
  const updates: Record<string, any> = {};

  switch (agentId) {
    case "pm":
      // PM produces acceptance criteria and subtask decomposition
      updates.acceptance_criteria = output.substring(0, 10000);
      break;
    case "architect":
      // Architect produces technical design and file impact analysis
      updates.architecture_ref = output.substring(0, 10000);
      break;
    case "qa":
      // QA produces review findings — append to dev_notes
      updates.dev_notes_qa = output.substring(0, 5000);
      break;
    default:
      // Other agents: log only (already in workflow_logs)
      return;
  }

  if (agentId === "qa") {
    // Append QA review to existing dev_notes
    const { data: current } = await supabase
      .from("tasks")
      .select("dev_notes")
      .eq("id", taskId)
      .single();
    const existingNotes = current?.dev_notes || "";
    updates.dev_notes = existingNotes + "\n\n--- QA REVIEW ---\n" + output.substring(0, 5000);
    delete updates.dev_notes_qa;
  }

  const { error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskId);
  if (error) console.error(`persistAgentArtifact(${agentId}) error:`, error);
}

// ── Main Orchestrate Function ────────────────────────────────

export interface OrchestrateOptions {
  pipeline?: AgentRole[];
  onProgress?: (message: string) => Promise<void>;
  /** Stop the pipeline if an agent fails */
  stopOnFailure?: boolean;
  /** Skip agents that aren't relevant (e.g., analyst for simple tasks) */
  skipIfSimple?: boolean;
  /** Max retry attempts per agent (default: 0 = no retry) */
  maxRetries?: number;
  /** Use dynamic pipeline selection based on task analysis (S22-06) */
  autoPipeline?: boolean;
  /** Use blackboard for structured context passing (S24) */
  useBlackboard?: boolean;
  /** S33: Resume from a previous pipeline run session ID */
  resumeSessionId?: string;
  /** S34: Per-role model overrides from LLM router (AC-019) */
  modelOverrides?: Partial<Record<AgentRole, string>>;
  /** S34: Enable model cascade for agents (Haiku -> Sonnet -> Opus) */
  cascade?: boolean;
  /** S43: Conversation context from the session that triggered this pipeline */
  conversationContext?: string;
  /** P1: Run the last 2 agents in parallel (overlap mode). Incompatible with useBlackboard */
  overlap?: boolean;
  /** P2: Rebuild agent context via buildAgentContext() between each agent (except the first) */
  refreshContext?: boolean;
}

/**
 * Orchestrate a task through a pipeline of BMad agents.
 *
 * Each agent receives structured outputs of all previous agents as context.
 * S22: Retry loop, structured message passing, dynamic pipeline selection.
 */
export async function orchestrate(
  supabase: SupabaseClient | null,
  task: Task,
  options: OrchestrateOptions = {}
): Promise<OrchestratedResult> {
  // S33: Resume from previous pipeline run
  let resumeFromStep = 0;
  let pipelineSessionId: string | null = null;

  if (options.resumeSessionId) {
    const savedState = await loadPipelineState(supabase, options.resumeSessionId);
    if (savedState) {
      const ctx = buildResumeContext(savedState);
      resumeFromStep = ctx.resumeFromStep;
      pipelineSessionId = options.resumeSessionId;
      // Pre-fill messages from completed steps
      if (options.onProgress) {
        await options.onProgress(
          `Resume pipeline depuis l'etape ${resumeFromStep} (${ctx.previousMessages.length} agents deja completes)`
        );
      }
      // Messages will be loaded below after pipeline selection
    }
  }

  // Dynamic pipeline selection (S22-06)
  let pipeline = options.autoPipeline
    ? selectPipeline(task, options.pipeline)
    : (options.pipeline || DEFAULT_PIPELINE);
  const maxRetries = options.maxRetries ?? 0;

  // Exploration phase: check if task needs research before decomposition
  let explorationScore: ExplorationScore | null = null;
  if (!options.resumeSessionId) {
    const pipelineType = pipeline === RESEARCH_PIPELINE ? "RESEARCH"
      : pipeline === SOLO_PIPELINE ? "SOLO"
      : pipeline === QUICK_PIPELINE ? "QUICK"
      : pipeline === REVIEW_PIPELINE ? "REVIEW"
      : pipeline === LIGHT_PIPELINE ? "LIGHT"
      : "DEFAULT";

    const exploreResult = await shouldExplore(task, { pipeline: pipelineType }, supabase);

    if (exploreResult.explore) {
      explorationScore = exploreResult.score;

      if (exploreResult.score?.forceResearch && !pipeline.includes("explorer")) {
        // Score >= 0.7: force RESEARCH pipeline
        pipeline = RESEARCH_PIPELINE;
        if (options.onProgress) {
          await options.onProgress(
            `Exploration fortement recommandee (score ${exploreResult.score.score}) : pipeline RESEARCH active`
          );
        }
      } else if (!pipeline.includes("explorer")) {
        // Score >= 0.5: prepend explorer to current pipeline
        pipeline = ["explorer", ...pipeline] as AgentRole[];
        if (options.onProgress) {
          await options.onProgress(
            `Phase exploration activee (score ${exploreResult.score?.score || "?"}) : explorer ajoute en tete du pipeline`
          );
        }
      }
    }
  }
  const startTime = Date.now();
  const steps: AgentStepResult[] = [];
  const messages: AgentMessage[] = [];

  // S33: Load previous messages if resuming
  if (options.resumeSessionId) {
    const savedState = await loadPipelineState(supabase, options.resumeSessionId);
    if (savedState) {
      messages.push(...savedState.stepsResults);
    }
  }

  // Load sharded context for the task (PRD, architecture docs)
  let shardedContext: string | undefined;
  if (supabase && task.project_id) {
    try {
      shardedContext = await buildTaskContext(
        supabase,
        task.title,
        task.project_id,
        4000 // token budget
      );
    } catch {
      // Sharding not available, proceed without
    }
  }

  // S32: Build Supabase context per agent role (cached, one fetch per role)
  const agentContextCache = new Map<string, string>();
  if (supabase) {
    const ctxResults = await Promise.all(
      pipeline.map(async (role) => {
        const ctx = await buildAgentContext(supabase, {
          role,
          projectId: task.project_id || undefined,
          sprintId: task.sprint || undefined,
          conversationContext: options.conversationContext,
        });
        return [role, ctx] as [string, string];
      })
    );
    for (const [role, ctx] of ctxResults) {
      if (ctx) agentContextCache.set(role, ctx);
    }
  }

  // Enrich task with story file before orchestration
  if (supabase) {
    const story = buildStoryFile(task);
    await enrichTaskWithStory(supabase, task.id, story);
    // Reload task with persisted story data
    const { data: refreshed } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", task.id)
      .single();
    if (refreshed) {
      Object.assign(task, refreshed);
    }
  }

  // Log selected pipeline (S22-07)
  const pipelineLabel = options.autoPipeline ? "auto" : "manual";

  if (options.onProgress) {
    const agentNames = pipeline.map((id) => {
      const a = getAgent(id);
      return a ? `${a.icon} ${a.name}` : id;
    });
    await options.onProgress(
      `Orchestration demarree (${pipelineLabel}) : ${agentNames.join(" -> ")}`
    );
  }

  // Track workflow if supabase available
  let tracker: WorkflowTracker | undefined;
  if (supabase) {
    tracker = new WorkflowTracker(supabase, {
      taskId: task.id,
      sprintId: task.sprint || undefined,
    });
  }

  // S33: Create pipeline run for checkpoint tracking (if not resuming)
  if (!pipelineSessionId) {
    pipelineSessionId = `pr-${task.id}-${Date.now()}`;
    await createPipelineRun(
      supabase,
      task.id,
      pipelineSessionId,
      classifyPipeline(task),
      pipeline
    );
  }

  // S24: Blackboard initialization
  let bbSessionId: string | null = null;
  let bbVersion = 1;
  let bbFallback: InMemoryBlackboard | null = null;
  const gateEvaluations: GateEvaluation[] = [];
  let driftReport: DriftReport | null = null;

  if (options.useBlackboard) {
    bbSessionId = `bb-${task.id}-${Date.now()}`;

    if (supabase) {
      const bb = await createBlackboard(
        supabase,
        task.id,
        bbSessionId,
        classifyPipeline(task),
        task.project_id || undefined
      );
      if (!bb) {
        // EC-008: fallback to in-memory
        console.warn("orchestrate: Supabase blackboard creation failed, using in-memory fallback");
        bbFallback = new InMemoryBlackboard();
        bbFallback.create(task.id, bbSessionId, classifyPipeline(task));
      }
    } else {
      // No supabase: in-memory fallback
      bbFallback = new InMemoryBlackboard();
      bbFallback.create(task.id, bbSessionId, classifyPipeline(task));
    }

    // Load SDD spec template into blackboard.spec (AC-023, FR-008)
    const specTemplatePath = join(
      process.env.PROJECT_DIR || process.cwd(),
      "config",
      "spec-template.md"
    );
    try {
      const template = readFileSync(specTemplatePath, "utf-8");
      if (supabase && !bbFallback) {
        const res = await writeSection(supabase, bbSessionId, "spec", { template, task_title: task.title, task_description: task.description }, "system", bbVersion);
        if (res.success) bbVersion = res.newVersion;
      } else if (bbFallback) {
        const res = bbFallback.write(bbSessionId, "spec", { template, task_title: task.title, task_description: task.description }, "system", bbVersion);
        if (res.success) bbVersion = res.newVersion;
      }
    } catch {
      // Template not available, proceed without
    }

    if (options.onProgress) {
      await options.onProgress("Blackboard initialise" + (bbFallback ? " (in-memory fallback)" : ""));
    }
  }

  // P1: Resolve overlap + blackboard incompatibility (R1c)
  let effectiveOverlap = options.overlap ?? false;
  if (effectiveOverlap && options.useBlackboard) {
    console.warn("orchestrate: overlap is incompatible with useBlackboard, falling back to sequential");
    effectiveOverlap = false;
  }

  // ── Sequential execution (with optional overlap for last 2 agents) ──
  {
    // P1: Determine which agents run sequentially vs in parallel
    const overlapThreshold = effectiveOverlap && pipeline.length >= 2
      ? pipeline.length - 2 // index where overlap starts
      : pipeline.length; // no overlap: all sequential

    let stepIndex = 0;
    for (const agentId of pipeline) {
      // S33: Skip already completed steps on resume
      if (stepIndex < resumeFromStep) {
        stepIndex++;
        continue;
      }
      stepIndex++;

      // P1: Break out of sequential loop to run overlap agents in parallel
      if (stepIndex - 1 >= overlapThreshold) {
        break;
      }

      const agent = getAgent(agentId);
      const agentLabel = agent
        ? `${agent.icon} ${agent.name} (${agent.title})`
        : agentId;

      // P2: Refresh context mid-pipeline (R4, R5, R6)
      if (options.refreshContext && stepIndex > 1 && supabase) {
        try {
          const refreshedCtx = await buildAgentContext(supabase, {
            role: agentId,
            projectId: task.project_id || undefined,
            sprintId: task.sprint || undefined,
            conversationContext: options.conversationContext,
          });
          // R6: Only update cache if refresh returned non-empty string
          if (refreshedCtx) {
            agentContextCache.set(agentId, refreshedCtx);
          }
        } catch {
          // R6: On error, preserve existing cache
        }
      }

      if (options.onProgress) {
        await options.onProgress(`${agentLabel} en cours...`);
      }

      // Log workflow transition
      if (tracker) {
        const stepName = `orchestration_${agentId}`;
        await tracker.transition(stepName, {
          agent_notes: `Agent ${agentId} demarre dans le pipeline`,
        });
      }

      // S38: Emit spawned event
      if (pipelineSessionId) {
        emitAgentEvent(supabase, pipelineSessionId, agentId, "spawned", {
          model: agent?.model, effort: agent?.effort,
        }).catch((err) => console.error("emitAgentEvent spawned error:", err));
      }

      // S22-04: Retry loop with exponential backoff
      let result: AgentStepResult | null = null;
      let retryCount = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // S38: Inject inter-agent messages into context
        let augmentedMessages = messages;
        if (options.useBlackboard && bbSessionId) {
          const interMessages = await getAgentMessages(supabase, bbSessionId, agentId);
          if (interMessages.length > 0) {
            const interCtx = buildInterAgentContext(interMessages, agentId);
            // Append inter-agent context to agent context
            const existingCtx = agentContextCache.get(agentId) || "";
            agentContextCache.set(agentId, existingCtx + "\n\n" + interCtx);
          }
        }

        result = await runAgentStep(agentId, task, augmentedMessages, shardedContext, agentContextCache.get(agentId), options.modelOverrides?.[agentId], options.cascade);

        if (result.success) break;

        if (attempt < maxRetries) {
          retryCount = attempt + 1;
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          if (options.onProgress) {
            await options.onProgress(
              `${agentLabel} echoue, retry ${retryCount}/${maxRetries} dans ${backoffMs / 1000}s...`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      // P3: Capture agent failure after retry exhaustion (R7, R8)
      if (result && !result.success && pipelineSessionId) {
        captureAgentFailure(supabase, pipelineSessionId, agentId, {
          promptSnippet: "", // prompt not readily available here, empty is acceptable
          partialOutput: (result.output || "").substring(0, 2000),
          error: result.error || "unknown error",
          tokensInput: result.tokensInput || 0,
          tokensOutput: result.tokensOutput || 0,
          durationMs: result.durationMs || 0,
        }).catch((err) => console.error("captureAgentFailure error:", err));
      }

      // result is never null here because maxRetries >= 0 guarantees at least one iteration
      result!.retryCount = retryCount;
      steps.push(result!);

      // S38: Emit completed/failed event
      if (pipelineSessionId) {
        const eventType = result!.success ? "completed" : "failed";
        emitAgentEvent(supabase, pipelineSessionId, agentId, eventType, {
          duration_ms: result!.durationMs,
          tokens_input: result!.tokensInput,
          tokens_output: result!.tokensOutput,
          cost_usd: result!.costUsd,
          ...(result!.error ? { error: result!.error } : {}),
        }).catch((err) => console.error("emitAgentEvent completed/failed error:", err));
      }

      // S38: Detect conflicts in working memory after agent completes
      if (options.useBlackboard && bbSessionId && result!.success) {
        try {
          const wm = supabase && !bbFallback
            ? await readSection(supabase, bbSessionId, "working_memory") as WorkingMemory | null
            : bbFallback?.read(bbSessionId, "working_memory") as WorkingMemory | null;
          const conflicts = detectConflicts(wm);
          for (const conflict of conflicts) {
            if (options.onProgress) {
              await options.onProgress(
                `Conflit detecte: ${conflict.agent1} vs ${conflict.agent2} sur "${conflict.subject.substring(0, 50)}"`
              );
            }
            // Write escalation message to blackboard
            if (supabase && !bbFallback) {
              const msg: AgentInterMessage = {
                id: crypto.randomUUID(),
                from: "system",
                to: getMediatingAgent(conflict.agent1, conflict.agent2),
                type: "escalation",
                content: `Conflit entre ${conflict.agent1} et ${conflict.agent2}: ${conflict.agent1Position} vs ${conflict.agent2Position}`,
                timestamp: new Date().toISOString(),
              };
              const res = await sendAgentMessage(supabase, bbSessionId, msg, bbVersion);
              if (res.success) bbVersion = res.newVersion;
            }
          }
        } catch {
          // Conflict detection is best-effort
        }
      }

      // S38: Check for pending clarifications after agent completes
      if (options.useBlackboard && bbSessionId && result!.success && supabase) {
        try {
          const pending = await checkPendingClarifications(supabase, bbSessionId);
          for (const q of pending) {
            // Check if we can do a round-trip
            if (canRequestClarification(pipelineSessionId!, q.from, q.to as string)) {
              markClarificationUsed(pipelineSessionId!, q.from, q.to as string);
              if (options.onProgress) {
                await options.onProgress(
                  `Clarification: ${q.from} demande a ${q.to}: ${q.content.substring(0, 60)}...`
                );
              }
              emitAgentEvent(supabase, pipelineSessionId!, q.from, "clarification_requested", {
                target_agent: q.to, question: q.content.substring(0, 200),
              }).catch((err) => console.error("emitAgentEvent clarification error:", err));
            }
          }
        } catch {
          // Clarification check is best-effort
        }
      }

      // S43: Deliberation protocol — reviewer challenges proposer
      if (result!.success && shouldDeliberate(agentId)) {
        const reviewerRole = getDeliberationReviewer(agentId);
        if (reviewerRole && pipeline.includes(reviewerRole)) {
          const deliberation = await runDeliberation(
            agentId,
            reviewerRole,
            result!.output,
            task,
            messages,
            shardedContext,
            agentContextCache.get(agentId),
            {
              modelOverride: options.modelOverrides?.[agentId],
              cascade: options.cascade,
              onProgress: options.onProgress,
            },
          );
          if (deliberation.revised) {
            result!.output = deliberation.output;
            result!.structured = parseAgentOutput(deliberation.output, agentId);
          }
        }
      }

      // Build AgentMessage for downstream agents
      const message: AgentMessage = {
        agentId,
        agentName: result!.agentName,
        success: result!.success,
        structured: result!.structured,
        rawOutput: result!.output,
        durationMs: result!.durationMs,
        error: result!.error,
      };
      messages.push(message);

      // S33: Checkpoint after each step
      if (pipelineSessionId) {
        const snapshot: StepSnapshot = {
          agentId,
          success: result!.success,
          durationMs: result!.durationMs,
          completedAt: new Date().toISOString(),
          tokensInput: result!.tokensInput,
          tokensOutput: result!.tokensOutput,
          costUsd: result!.costUsd,
        };
        await savePipelineStep(supabase, pipelineSessionId, snapshot, message);
      }

      // Persist agent artifacts to the task in Supabase
      if (result!.success && supabase) {
        await persistAgentArtifact(supabase, task.id, agentId, result!.output);
      }

      // Write exploration report to blackboard + inject into downstream agent contexts
      if (agentId === "explorer" && result!.success) {
        try {
          const explorationReport = parseExplorationPhaseOutput(result!.output);
          const formattedReport = explorationReport
            ? formatExplorationPhaseOutput(explorationReport)
            : result!.output.substring(0, 4000);

          // Inject exploration report into all remaining agents' context
          for (const remainingRole of pipeline) {
            if (remainingRole === "explorer") continue;
            const existing = agentContextCache.get(remainingRole) || "";
            // Rebuild context with exploration report if supabase available
            if (supabase) {
              const enrichedCtx = await buildAgentContext(supabase, {
                role: remainingRole,
                projectId: task.project_id || undefined,
                sprintId: task.sprint || undefined,
                conversationContext: options.conversationContext,
                explorationReport: formattedReport,
              });
              if (enrichedCtx) agentContextCache.set(remainingRole, enrichedCtx);
            } else {
              // No supabase: append exploration report directly
              agentContextCache.set(remainingRole, existing + "\n\nRAPPORT EXPLORATION:\n" + formattedReport);
            }
          }

          // Write to blackboard if enabled
          if (bbSessionId) {
            const explorationData = explorationReport || { raw: result!.output.substring(0, 10000) };
            if (supabase && !bbFallback) {
              const currentSpec = await readSection(supabase, bbSessionId, "spec") || {};
              const res = await writeSection(supabase, bbSessionId, "spec", { ...currentSpec, exploration: explorationData }, "explorer", bbVersion);
              if (res.success) bbVersion = res.newVersion;
            } else if (bbFallback) {
              const currentSpec = bbFallback.read(bbSessionId, "spec") || {};
              const res = bbFallback.write(bbSessionId, "spec", { ...currentSpec, exploration: explorationData }, "explorer", bbVersion);
              if (res.success) bbVersion = res.newVersion;
            }
          }
        } catch {
          // Best-effort exploration report storage
        }
      }

      // S24: Write to blackboard section + gate evaluation
      if (options.useBlackboard && bbSessionId && result!.success) {
        const sectionMap: Record<string, SectionName> = {
          analyst: "spec",
          pm: "tasks",
          architect: "plan",
          dev: "implementation",
          qa: "verification",
        };
        const section = sectionMap[agentId];
        if (section) {
          const sectionData = result!.structured || { raw: result!.output.substring(0, 30000) };
          if (supabase && !bbFallback) {
            const res = await writeSection(supabase, bbSessionId, section, sectionData, agentId, bbVersion);
            if (res.success) bbVersion = res.newVersion;
          } else if (bbFallback) {
            const res = bbFallback.write(bbSessionId, section, sectionData, agentId, bbVersion);
            if (res.success) bbVersion = res.newVersion;
          }

          // Gate evaluation for pm, architect, dev (not analyst/qa)
          const gateMap: Record<string, GateName> = {
            pm: "tasks",
            architect: "plan",
            dev: "implementation",
          };
          const gate = gateMap[agentId];
          if (gate) {
            if (options.onProgress) {
              await options.onProgress(`Gate evaluation: ${gate}...`);
            }
            const reworkResult = await evaluateAndRework(
              supabase,
              bbSessionId,
              agentId,
              gate,
              sectionData,
              async (feedback: string) => {
                if (options.onProgress) {
                  await options.onProgress(`Rework ${agentId} avec feedback des gates...`);
                }
                const reworkMessages = [...messages, {
                  agentId,
                  agentName: result!.agentName,
                  success: false,
                  structured: null,
                  rawOutput: feedback,
                  durationMs: 0,
                }];
                const reworkResult = await runAgentStep(agentId, task, reworkMessages, shardedContext, agentContextCache.get(agentId), options.modelOverrides?.[agentId], options.cascade);
                if (reworkResult.success) {
                  const newData = reworkResult.structured || { raw: reworkResult.output.substring(0, 30000) };
                  // Update blackboard with reworked output
                  if (supabase && !bbFallback) {
                    const res = await writeSection(supabase, bbSessionId, section, newData, agentId, bbVersion);
                    if (res.success) bbVersion = res.newVersion;
                  } else if (bbFallback) {
                    const res = bbFallback.write(bbSessionId, section, newData, agentId, bbVersion);
                    if (res.success) bbVersion = res.newVersion;
                  }
                  // Update step result
                  result = reworkResult;
                  messages[messages.length - 1] = {
                    agentId,
                    agentName: reworkResult.agentName,
                    success: reworkResult.success,
                    structured: reworkResult.structured,
                    rawOutput: reworkResult.output,
                    durationMs: reworkResult.durationMs,
                  };
                  return newData;
                }
                return reworkResult.structured || { raw: reworkResult.output.substring(0, 30000) };
              },
              {
                maxIterations: 2,
                taskId: task.id,
                sprintId: task.sprint || undefined,
                taskPriority: task.priority,
              }
            );
            gateEvaluations.push(reworkResult.finalEvaluation);
            if (options.onProgress) {
              const status = reworkResult.finalEvaluation.pass ? "PASS" : "FAIL";
              const reworkNote = reworkResult.iterations > 0 ? ` (${reworkResult.iterations} rework)` : "";
              await options.onProgress(`Gate ${gate}: ${status} (${reworkResult.finalEvaluation.score}/100)${reworkNote}`);
            }
          }
        }
      }

      // Log cost with span attribution (S23-05, S28, LLM-Ops R4/R8)
      if (supabase && result!.tokensInput) {
        const spanId = pipelineSessionId ? buildSpanId(pipelineSessionId, agentId, stepIndex - 1) : "";
        logCostWithSpan(supabase, {
          taskId: task.id,
          sprintId: task.sprint || undefined,
          agentRole: agentId,
          agentName: result!.agentName,
          tokensInput: result!.tokensInput || 0,
          tokensOutput: result!.tokensOutput || 0,
          costUsd: result!.costUsd || 0,
          durationMs: result!.durationMs,
          retryAttempt: retryCount,
          context: "orchestration",
          model: agent?.model,
          metadata: pipelineSessionId ? { pipeline_session_id: pipelineSessionId } : undefined,
        }, spanId, pipelineSessionId || "").catch((err) => console.error("logCost orchestration error:", err));
      }

      // LLM-Ops: record prompt version (R3, R11 — fire-and-forget)
      if (supabase && pipelineSessionId) {
        const yaml = loadAgentYaml(agentId);
        const yamlContent = yaml ? JSON.stringify(yaml) : "";
        const templateH = sha256(yamlContent);
        const feedbackRules = getFeedbackRulesForAgent(agentId as any);
        const feedbackH = sha256(JSON.stringify(feedbackRules));
        recordPromptVersion(supabase, agentId, templateH, feedbackH)
          .catch((err) => console.error("recordPromptVersion error:", err));
      }

      if (options.onProgress) {
        const status = result!.success ? "OK" : "ECHEC";
        const duration = Math.round(result!.durationMs / 1000);
        const retryInfo = retryCount > 0 ? ` (${retryCount} retries)` : "";
        await options.onProgress(
          `${agentLabel} : ${status} (${duration}s)${retryInfo}`
        );
      }

      // Log checkpoint (S22-05: include retry metrics)
      if (tracker) {
        await tracker.logCheckpoint(
          result!.success ? "pass" : "fail",
          `Agent ${agentId}: ${result!.success ? "succes" : "echec"} en ${result!.durationMs}ms` +
            (retryCount > 0 ? ` (${retryCount} retries)` : "")
        );
      }

      // Stop on failure if configured
      if (!result!.success && options.stopOnFailure) {
        // S33: Mark pipeline as failed for future resume
        if (pipelineSessionId) {
          await updatePipelineStatus(supabase, pipelineSessionId, "failed", result!.error);
        }
        if (options.onProgress) {
          await options.onProgress(
            `Pipeline arrete: ${agentLabel} a echoue.` +
            (pipelineSessionId ? ` Reprendre avec --resume ${pipelineSessionId}` : "")
          );
        }
        break;
      }
    }

    // P1: Overlap execution — run last 2 agents in parallel (R1, R1b, R1d)
    if (effectiveOverlap && pipeline.length >= 2) {
      // Only run overlap if sequential part didn't fail with stopOnFailure
      const lastFailed = steps.length > 0 && !steps[steps.length - 1].success && options.stopOnFailure;
      if (!lastFailed) {
        const overlapAgents = pipeline.slice(overlapThreshold);
        const previousMessagesSnapshot = [...messages]; // R1d: frozen snapshot

        const overlapPromises = overlapAgents.map(async (agentId) => {
          const agent = getAgent(agentId);
          const agentLabel = agent
            ? `${agent.icon} ${agent.name} (${agent.title})`
            : agentId;

          // P2: Refresh context for overlap agents too
          if (options.refreshContext && supabase) {
            try {
              const refreshedCtx = await buildAgentContext(supabase, {
                role: agentId,
                projectId: task.project_id || undefined,
                sprintId: task.sprint || undefined,
                conversationContext: options.conversationContext,
              });
              if (refreshedCtx) {
                agentContextCache.set(agentId, refreshedCtx);
              }
            } catch {
              // Preserve existing cache
            }
          }

          if (options.onProgress) {
            await options.onProgress(`${agentLabel} en cours (overlap)...`);
          }

          if (tracker) {
            await tracker.transition(`orchestration_${agentId}`, {
              agent_notes: `Agent ${agentId} demarre dans le pipeline (overlap)`,
            });
          }

          if (pipelineSessionId) {
            emitAgentEvent(supabase, pipelineSessionId, agentId, "spawned", {
              model: agent?.model, effort: agent?.effort, overlap: true,
            }).catch((err) => console.error("emitAgentEvent spawned error:", err));
          }

          // Retry loop for overlap agent
          let result: AgentStepResult | null = null;
          let retryCount = 0;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            result = await runAgentStep(
              agentId, task, previousMessagesSnapshot, shardedContext,
              agentContextCache.get(agentId), options.modelOverrides?.[agentId], options.cascade
            );
            if (result.success) break;
            if (attempt < maxRetries) {
              retryCount = attempt + 1;
              const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }

          // P3: DLQ capture for overlap agents
          if (result && !result.success && pipelineSessionId) {
            captureAgentFailure(supabase, pipelineSessionId, agentId, {
              promptSnippet: "",
              partialOutput: (result.output || "").substring(0, 2000),
              error: result.error || "unknown error",
              tokensInput: result.tokensInput || 0,
              tokensOutput: result.tokensOutput || 0,
              durationMs: result.durationMs || 0,
            }).catch((err) => console.error("captureAgentFailure error:", err));
          }

          result!.retryCount = retryCount;

          // Emit completed/failed event
          if (pipelineSessionId) {
            const eventType = result!.success ? "completed" : "failed";
            emitAgentEvent(supabase, pipelineSessionId, agentId, eventType, {
              duration_ms: result!.durationMs,
              tokens_input: result!.tokensInput,
              tokens_output: result!.tokensOutput,
              cost_usd: result!.costUsd,
              overlap: true,
              ...(result!.error ? { error: result!.error } : {}),
            }).catch((err) => console.error("emitAgentEvent error:", err));
          }

          // Log cost with span attribution (LLM-Ops R4/R8)
          if (supabase && result!.tokensInput) {
            const overlapStepIdx = pipeline.indexOf(agentId);
            const spanId = pipelineSessionId ? buildSpanId(pipelineSessionId, agentId, overlapStepIdx) : "";
            logCostWithSpan(supabase, {
              taskId: task.id,
              sprintId: task.sprint || undefined,
              agentRole: agentId,
              agentName: result!.agentName,
              tokensInput: result!.tokensInput || 0,
              tokensOutput: result!.tokensOutput || 0,
              costUsd: result!.costUsd || 0,
              durationMs: result!.durationMs,
              retryAttempt: retryCount,
              context: "orchestration",
              model: agent?.model,
              metadata: pipelineSessionId ? { pipeline_session_id: pipelineSessionId } : undefined,
            }, spanId, pipelineSessionId || "").catch((err) => console.error("logCost orchestration error:", err));
          }

          // Checkpoint
          if (pipelineSessionId) {
            const snapshot: StepSnapshot = {
              agentId,
              success: result!.success,
              durationMs: result!.durationMs,
              completedAt: new Date().toISOString(),
              tokensInput: result!.tokensInput,
              tokensOutput: result!.tokensOutput,
              costUsd: result!.costUsd,
            };
            const message: AgentMessage = {
              agentId,
              agentName: result!.agentName,
              success: result!.success,
              structured: result!.structured,
              rawOutput: result!.output,
              durationMs: result!.durationMs,
              error: result!.error,
            };
            await savePipelineStep(supabase, pipelineSessionId, snapshot, message);
          }

          // Persist artifact
          if (result!.success && supabase) {
            await persistAgentArtifact(supabase, task.id, agentId, result!.output);
          }

          return { agentId, result: result! };
        });

        // R1b: Use Promise.allSettled to preserve both results
        const settled = await Promise.allSettled(overlapPromises);

        // Process results in pipeline order
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            const { agentId: aId, result: r } = outcome.value;
            steps.push(r);
            messages.push({
              agentId: aId,
              agentName: r.agentName,
              success: r.success,
              structured: r.structured,
              rawOutput: r.output,
              durationMs: r.durationMs,
              error: r.error,
            });

            if (options.onProgress) {
              const agent = getAgent(aId);
              const label = agent ? `${agent.icon} ${agent.name} (${agent.title})` : aId;
              const status = r.success ? "OK" : "ECHEC";
              const duration = Math.round(r.durationMs / 1000);
              await options.onProgress(`${label} : ${status} (${duration}s) [overlap]`);
            }
          } else {
            // Unexpected rejection — create a synthetic failure step
            console.error("orchestrate overlap: unexpected rejection", outcome.reason);
          }
        }

        // R1b: Check if any overlap agent failed with stopOnFailure
        if (options.stopOnFailure) {
          const overlapFailed = steps.slice(-overlapAgents.length).some(s => !s.success);
          if (overlapFailed && pipelineSessionId) {
            const failedStep = steps.find(s => !s.success);
            await updatePipelineStatus(supabase, pipelineSessionId, "failed", failedStep?.error);
            if (options.onProgress) {
              await options.onProgress(
                `Pipeline arrete: agent en overlap a echoue.` +
                (pipelineSessionId ? ` Reprendre avec --resume ${pipelineSessionId}` : "")
              );
            }
          }
        }
      }
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // S33: Mark pipeline as completed (if not already failed)
  if (pipelineSessionId) {
    const finalStatus = steps.every((s) => s.success) ? "completed" : "failed";
    await updatePipelineStatus(supabase, pipelineSessionId, finalStatus);
  }

  // S24: Adversarial verifier + traceability (after all agents done)
  let traceabilityReport: ReturnType<typeof generateTraceabilityReport> | null = null;

  if (options.useBlackboard && bbSessionId) {
    // Adversarial verifier (skip for QUICK — EC-006)
    const pipelineTypeLabel = classifyPipeline(task);
    if (pipelineTypeLabel !== "QUICK") {
      if (options.onProgress) {
        await options.onProgress("Adversarial verification en cours...");
      }

      let spec: any = null;
      let impl: any = null;
      if (supabase && !bbFallback) {
        spec = await readSection(supabase, bbSessionId, "spec");
        impl = await readSection(supabase, bbSessionId, "implementation");
      } else if (bbFallback) {
        spec = bbFallback.read(bbSessionId, "spec");
        impl = bbFallback.read(bbSessionId, "implementation");
      }

      driftReport = await verifySpecVsImplementation(spec, impl, pipelineTypeLabel);

      if (driftReport && supabase) {
        await persistDriftReport(supabase, bbSessionId, task.id, driftReport);
      }

      if (options.onProgress && driftReport) {
        await options.onProgress(
          `Adversarial verification: ${driftReport.coverage_score}% coverage — ${driftReport.overall_verdict.toUpperCase()}`
        );
      }
    }

    // Traceability report
    let sections: any = null;
    if (supabase && !bbFallback) {
      const bb = await getFullBlackboard(supabase, bbSessionId);
      if (bb) sections = bb.sections;
    } else if (bbFallback) {
      const bb = bbFallback.get(bbSessionId);
      if (bb) sections = bb.sections;
    }

    if (sections) {
      traceabilityReport = generateTraceabilityReport(sections);
      if (options.onProgress) {
        await options.onProgress(
          `Traceability: ${traceabilityReport.coverage_percentage}% FR coverage`
        );
      }
    }

    // Mark blackboard as completed
    if (supabase && !bbFallback) {
      await updateBlackboardStatus(supabase, bbSessionId, steps.every(s => s.success) ? "completed" : "failed");
    }
  }

  // S38: Cleanup session trackers
  if (pipelineSessionId) {
    clearClarificationTracker(pipelineSessionId);
    clearInMemoryEvents(pipelineSessionId);
  }

  // Build summary
  const summary = buildOrchestrationSummary(steps, totalDurationMs);

  // Log orchestration result to Supabase (S22-05/07: include retry metrics + pipeline selection)
  if (supabase) {
    await logOrchestrationResult(supabase, task.id, steps, totalDurationMs, pipelineLabel);
  }

  const orchestratedResult: OrchestratedResult = {
    success: steps.every((s) => s.success),
    steps,
    totalDurationMs,
    summary,
  };

  // Attach blackboard data if used
  if (options.useBlackboard && bbSessionId) {
    orchestratedResult.blackboard = {
      sessionId: bbSessionId,
      gateEvaluations,
      driftReport,
      traceabilityReport,
    };
  }

  return orchestratedResult;
}

// ── Helpers ──────────────────────────────────────────────────

function buildOrchestrationSummary(
  steps: AgentStepResult[],
  totalDurationMs: number
): string {
  const lines: string[] = [];
  lines.push("ORCHESTRATION TERMINEE");
  lines.push(`Duree totale: ${Math.round(totalDurationMs / 1000)}s`);
  lines.push(`Agents: ${steps.length}`);
  lines.push(`Succes: ${steps.filter((s) => s.success).length}/${steps.length}`);

  const totalRetries = steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  if (totalRetries > 0) {
    lines.push(`Retries: ${totalRetries}`);
  }

  const structuredCount = steps.filter((s) => s.structured).length;
  if (structuredCount > 0) {
    lines.push(`Sorties structurees: ${structuredCount}/${steps.length}`);
  }

  const totalCost = steps.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokensInput || 0) + (s.tokensOutput || 0), 0);
  if (totalTokens > 0) {
    lines.push(`Tokens: ~${totalTokens} (~$${totalCost.toFixed(4)})`);
  }
  lines.push("");

  for (const step of steps) {
    const status = step.success ? "OK" : "ECHEC";
    const duration = Math.round(step.durationMs / 1000);
    const retryInfo = step.retryCount ? ` [${step.retryCount} retries]` : "";
    lines.push(`${step.agentName} (${step.agentId}): ${status} — ${duration}s${retryInfo}`);

    // Add a brief excerpt of the output (first 200 chars)
    if (step.output) {
      const excerpt = step.output.substring(0, 200).replace(/\n/g, " ");
      lines.push(`  ${excerpt}${step.output.length > 200 ? "..." : ""}`);
    }
    if (step.error) {
      lines.push(`  ERREUR: ${step.error.substring(0, 150)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

async function logOrchestrationResult(
  supabase: SupabaseClient,
  taskId: string,
  steps: AgentStepResult[],
  totalDurationMs: number,
  pipelineSelection?: string
): Promise<void> {
  const totalRetries = steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  const { error } = await supabase.from("workflow_logs").insert({
    task_id: taskId,
    step_from: "orchestration_start",
    step_to: "orchestration_end",
    metadata: {
      type: "orchestration",
      pipeline: steps.map((s) => s.agentId),
      pipelineSelection: pipelineSelection || "manual",
      results: steps.map((s) => ({
        agent: s.agentId,
        success: s.success,
        durationMs: s.durationMs,
        outputLength: s.output.length,
        hasStructuredOutput: s.structured !== null,
        retryCount: s.retryCount || 0,
        tokensInput: s.tokensInput || 0,
        tokensOutput: s.tokensOutput || 0,
        costUsd: s.costUsd || 0,
      })),
      totalDurationMs,
      totalRetries,
      totalCost: steps.reduce((sum, s) => sum + (s.costUsd || 0), 0),
      allPassed: steps.every((s) => s.success),
    },
  });
  if (error) console.error("logOrchestrationResult error:", error);
}

// ── Format for Telegram ──────────────────────────────────────

export function formatOrchestrationResult(result: OrchestratedResult): string {
  const lines: string[] = [];

  const statusIcon = result.success ? "OK" : "ATTENTION";
  lines.push(`ORCHESTRATION ${statusIcon}`);
  lines.push(`Duree: ${Math.round(result.totalDurationMs / 1000)}s`);

  const totalRetries = result.steps.reduce((sum, s) => sum + (s.retryCount || 0), 0);
  if (totalRetries > 0) {
    lines.push(`Retries: ${totalRetries}`);
  }

  const totalCost = result.steps.reduce((sum, s) => sum + (s.costUsd || 0), 0);
  if (totalCost > 0) {
    lines.push(`Cout: ~$${totalCost.toFixed(4)}`);
  }
  lines.push("");

  for (const step of result.steps) {
    const agent = getAgent(step.agentId);
    const icon = agent?.icon || "";
    const status = step.success ? "ok" : "echec";
    const duration = Math.round(step.durationMs / 1000);
    const structuredTag = step.structured ? " [JSON]" : "";
    const retryTag = step.retryCount ? ` (${step.retryCount} retries)` : "";
    const costTag = step.costUsd ? ` ~$${step.costUsd.toFixed(4)}` : "";
    lines.push(`${icon} ${step.agentName} : ${status} (${duration}s)${structuredTag}${retryTag}${costTag}`);
  }

  // S24: Blackboard results
  if (result.blackboard) {
    const bb = result.blackboard;
    lines.push("");
    lines.push("--- Blackboard ---");

    if (bb.gateEvaluations.length > 0) {
      lines.push("Gates:");
      for (const gate of bb.gateEvaluations) {
        const status = gate.pass ? "PASS" : "FAIL";
        lines.push(`  ${gate.gate_name}: ${status} (${gate.score}/100)`);
        if (gate.issues.length > 0) {
          for (const issue of gate.issues.slice(0, 3)) {
            lines.push(`    [${issue.severity}] ${issue.description}`);
          }
        }
      }
    }

    if (bb.driftReport) {
      lines.push("");
      lines.push(formatDriftReport(bb.driftReport));
    }

    if (bb.traceabilityReport) {
      lines.push("");
      lines.push(formatTraceabilityReport(bb.traceabilityReport));
    }
  }

  // Add last agent's output as the main result (formatted as plain text)
  const lastSuccessful = [...result.steps].reverse().find((s) => s.success);
  if (lastSuccessful) {
    lines.push("");
    lines.push("--- Resultat ---");
    const maxLen = 3000;
    // Use structured output formatted as plain text when available
    const output = lastSuccessful.structured
      ? formatStructuredOutput(lastSuccessful.structured)
      : lastSuccessful.output;
    if (output) {
      lines.push(output.length > maxLen ? output.substring(0, maxLen) + "..." : output);
    }
  }

  return lines.join("\n");
}
