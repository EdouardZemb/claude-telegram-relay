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
} from "./agent-schemas.ts";
import { parseTokenUsage, logCost, estimateCost } from "./cost-tracking.ts";
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
import {
  executeDag,
  getDAG,
  buildSequentialDAG,
  type DAGNode,
  type DAGExecutionResult,
} from "./dag-executor.ts";
import { Supervisor, type SupervisorReport } from "./supervisor.ts";
import {
  fanOut,
  fanIn,
  parseSubtasks,
  shouldFanOut,
  type FanOutResult,
} from "./fan-out.ts";
import { writeSectionWithRetry, mergeImplementationSection } from "./blackboard.ts";
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
import { emitAgentEvent, clearInMemoryEvents } from "./agent-events.ts";
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
import { isFeatureEnabled } from "./feature-flags.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

// ── Types ────────────────────────────────────────────────────

export type AgentRole = "analyst" | "pm" | "architect" | "dev" | "qa" | "sm";

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

/** S25: Parallel execution metrics */
export interface ParallelMetrics {
  total_wall_time_ms: number;
  sequential_equivalent_ms: number;
  speedup_ratio: number;
  per_agent_timing: Array<{
    agent: AgentRole;
    startMs: number;
    endMs: number;
    durationMs: number;
  }>;
  fan_out_count: number;
  concurrent_peak: number;
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
  /** S25: Parallel metrics (only present when parallel=true) */
  parallelMetrics?: ParallelMetrics;
}

/** Maps agent roles to the workflow command they execute */
const AGENT_COMMAND_MAP: Record<AgentRole, string> = {
  analyst: "patterns",
  pm: "plan",
  architect: "architecture",
  dev: "exec",
  qa: "alerts",
  sm: "sprint",
};

/** Default pipeline: full BMad flow */
export const DEFAULT_PIPELINE: AgentRole[] = [
  "analyst",
  "pm",
  "architect",
  "dev",
  "qa",
];

/** Quick pipeline: skip analysis, go straight to dev */
export const QUICK_PIPELINE: AgentRole[] = ["dev", "qa"];

/** Review-only pipeline */
export const REVIEW_PIPELINE: AgentRole[] = ["qa", "architect"];

// ── Core Orchestrator ────────────────────────────────────────

/**
 * Run a single agent step: build prompt, call Claude, return result.
 * S22: Uses structured output instructions and parses JSON from output.
 */
async function runAgentStep(
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
      maxBudgetUsd: agent?.maxBudgetUsd,
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

// ── S43: Deliberation Protocol ────────────────────────────────

/**
 * Deliberation pairs: after a strategic agent completes, the next agent
 * reviews their output and can request a revision. Max 1 round-trip.
 */
const DELIBERATION_PAIRS: Record<string, string> = {
  architect: "pm",    // PM validates architect's design feasibility
  dev: "qa",          // QA pre-reviews dev's implementation plan
};

/**
 * Run a deliberation round between two agents.
 * The reviewer examines the proposer's output and flags issues.
 * If issues found, the proposer revises (1 iteration max).
 * Returns the (possibly revised) output.
 *
 * S43-04: Behind "deliberation" feature flag.
 */
export async function runDeliberation(
  proposerRole: AgentRole,
  reviewerRole: AgentRole,
  proposerOutput: string,
  task: Task,
  messages: AgentMessage[],
  shardedContext?: string,
  agentContext?: string,
  options?: { modelOverride?: string; cascade?: boolean; onProgress?: (msg: string) => Promise<void> },
): Promise<{ output: string; revised: boolean; reviewerFeedback: string }> {
  const proposerAgent = getAgent(proposerRole);
  const reviewerAgent = getAgent(reviewerRole);
  const proposerLabel = proposerAgent ? `${proposerAgent.icon} ${proposerAgent.name}` : proposerRole;
  const reviewerLabel = reviewerAgent ? `${reviewerAgent.icon} ${reviewerAgent.name}` : reviewerRole;

  // Step 1: Reviewer examines proposer's output
  const reviewPrompt = [
    `Tu es ${reviewerLabel} et tu revois le travail de ${proposerLabel}.`,
    "",
    "PROPOSITION A REVOIR:",
    proposerOutput.substring(0, 5000),
    "",
    "INSTRUCTIONS:",
    "- Identifie les problemes concrets (faisabilite, coherence, manques)",
    "- Si tout est acceptable, reponds: APPROVE",
    "- Si des corrections sont necessaires, reponds: REVISE suivi de tes feedbacks",
    "- Sois concis et specifique",
    "- Maximum 3 points de feedback",
  ].join("\n");

  if (options?.onProgress) {
    await options.onProgress(`Deliberation: ${reviewerLabel} revoit ${proposerLabel}...`);
  }

  const reviewResult = await spawnClaude({
    prompt: reviewPrompt,
    effort: "low",
    model: reviewerAgent?.model || "sonnet",
    maxBudgetUsd: 0.05,
  });

  const reviewOutput = reviewResult.stdout.trim();

  // Check if approved
  if (reviewOutput.toUpperCase().includes("APPROVE") && !reviewOutput.toUpperCase().includes("REVISE")) {
    if (options?.onProgress) {
      await options.onProgress(`Deliberation: ${reviewerLabel} approuve ${proposerLabel}`);
    }
    return { output: proposerOutput, revised: false, reviewerFeedback: reviewOutput };
  }

  // Step 2: Proposer revises based on feedback
  if (options?.onProgress) {
    await options.onProgress(`Deliberation: ${proposerLabel} revise suite au feedback de ${reviewerLabel}...`);
  }

  const revisionMessages: AgentMessage[] = [
    ...messages,
    {
      agentId: reviewerRole,
      agentName: reviewerAgent?.name || reviewerRole,
      success: true,
      structured: null,
      rawOutput: `FEEDBACK DE DELIBERATION (${reviewerLabel}):\n${reviewOutput}`,
      durationMs: 0,
    },
  ];

  const revisedResult = await runAgentStep(
    proposerRole,
    task,
    revisionMessages,
    shardedContext,
    agentContext,
    options?.modelOverride,
    options?.cascade,
  );

  if (revisedResult.success) {
    if (options?.onProgress) {
      await options.onProgress(`Deliberation: ${proposerLabel} a revise sa proposition`);
    }
    return { output: revisedResult.output, revised: true, reviewerFeedback: reviewOutput };
  }

  // Revision failed — keep original
  return { output: proposerOutput, revised: false, reviewerFeedback: reviewOutput };
}

/**
 * Check if deliberation should happen after this agent.
 */
export function shouldDeliberate(agentId: AgentRole): boolean {
  return agentId in DELIBERATION_PAIRS;
}

/**
 * Get the reviewer role for a given proposer.
 */
export function getDeliberationReviewer(agentId: AgentRole): AgentRole | null {
  return (DELIBERATION_PAIRS[agentId] as AgentRole) || null;
}

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
  /** S25: Enable parallel DAG-based execution */
  parallel?: boolean;
  /** S25: Max concurrent agents (default: 3) */
  maxConcurrency?: number;
  /** S33: Resume from a previous pipeline run session ID */
  resumeSessionId?: string;
  /** S34: Per-role model overrides from LLM router (AC-019) */
  modelOverrides?: Partial<Record<AgentRole, string>>;
  /** S34: Enable model cascade for agents (Haiku -> Sonnet -> Opus) */
  cascade?: boolean;
  /** S43: Conversation context from the session that triggered this pipeline */
  conversationContext?: string;
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
  const pipeline = options.autoPipeline
    ? selectPipeline(task, options.pipeline)
    : (options.pipeline || DEFAULT_PIPELINE);
  const maxRetries = options.maxRetries ?? 0;
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

  // S25: Parallel or sequential execution
  let supervisorReport: SupervisorReport | null = null;
  let fanOutCount = 0;

  if (options.parallel) {
    // ── S25: DAG-based parallel execution ────────────────────
    const pipelineTypeForDag = classifyPipeline(task);
    const dag = getDAG(pipelineTypeForDag, pipeline);
    const supervisor = new Supervisor({
      maxAttempts: maxRetries + 1,
    });

    // Register all agents with supervisor
    for (const agentId of dag.keys()) {
      supervisor.register(agentId, agentId);
    }
    supervisor.startPipeline();

    if (options.onProgress) {
      await options.onProgress(`Execution parallele (DAG, max concurrency: ${options.maxConcurrency ?? 3})`);
    }

    const s38ParallelEnabled = isFeatureEnabled("inter_agent_messaging");

    const dagResult = await executeDag(dag, async (agentId, previousResults) => {
      // Build messages from previous results
      const prevMessages: AgentMessage[] = [];
      for (const [prevId, prevResult] of previousResults) {
        prevMessages.push({
          agentId: prevId,
          agentName: prevResult.agentName,
          success: prevResult.success,
          structured: prevResult.structured,
          rawOutput: prevResult.output,
          durationMs: prevResult.durationMs,
          error: prevResult.error,
        });
      }

      // S38: Emit spawned event
      if (s38ParallelEnabled && pipelineSessionId) {
        const agentDef = getAgent(agentId);
        emitAgentEvent(supabase, pipelineSessionId, agentId, "spawned", {
          model: agentDef?.model, effort: agentDef?.effort,
        }).catch(() => {});
      }

      // S38: Inject inter-agent messages into context
      if (s38ParallelEnabled && options.useBlackboard && bbSessionId) {
        const interMessages = await getAgentMessages(supabase, bbSessionId, agentId);
        if (interMessages.length > 0) {
          const interCtx = buildInterAgentContext(interMessages, agentId);
          const existingCtx = agentContextCache.get(agentId) || "";
          agentContextCache.set(agentId, existingCtx + "\n\n" + interCtx);
        }
      }

      supervisor.markStarted(agentId);
      const result = await runAgentStep(agentId, task, prevMessages, shardedContext, agentContextCache.get(agentId), options.modelOverrides?.[agentId], options.cascade);
      supervisor.markCompleted(agentId, result);

      // S38: Emit completed/failed event
      if (s38ParallelEnabled && pipelineSessionId) {
        emitAgentEvent(supabase, pipelineSessionId, agentId,
          result.success ? "completed" : "failed",
          { duration_ms: result.durationMs, tokens_input: result.tokensInput, cost_usd: result.costUsd }
        ).catch(() => {});
      }

      return result;
    }, {
      maxConcurrency: options.maxConcurrency ?? 3,
      onNodeStarted: (agentId) => {
        const agent = getAgent(agentId);
        const label = agent ? `${agent.icon} ${agent.name}` : agentId;
        options.onProgress?.(`${label} demarre (parallele)...`);
      },
      onNodeCompleted: (agentId, result) => {
        const agent = getAgent(agentId);
        const label = agent ? `${agent.icon} ${agent.name}` : agentId;
        const status = result.success ? "OK" : "ECHEC";
        const duration = Math.round(result.durationMs / 1000);
        options.onProgress?.(`${label} : ${status} (${duration}s)`);
      },
      onNodeFailed: async (node) => {
        return supervisor.decide(node.agent);
      },
    });

    // Collect results from DAG
    for (const node of dagResult.nodes) {
      if (node.result) {
        steps.push(node.result);

        // Build message for context
        messages.push({
          agentId: node.agent,
          agentName: node.result.agentName,
          success: node.result.success,
          structured: node.result.structured,
          rawOutput: node.result.output,
          durationMs: node.result.durationMs,
          error: node.result.error,
        });

        // Persist artifacts
        if (node.result.success && supabase) {
          await persistAgentArtifact(supabase, task.id, node.agent, node.result.output);
        }

        // S24: Write to blackboard
        if (options.useBlackboard && bbSessionId && node.result.success) {
          const sectionMap: Record<string, SectionName> = {
            analyst: "spec", pm: "tasks", architect: "plan",
            dev: "implementation", qa: "verification",
          };
          const section = sectionMap[node.agent];
          if (section) {
            const sectionData = node.result.structured || { raw: node.result.output.substring(0, 30000) };
            if (supabase && !bbFallback) {
              const res = await writeSectionWithRetry(supabase, bbSessionId, section, sectionData, node.agent, bbVersion);
              if (res.success) bbVersion = res.newVersion;
            } else if (bbFallback) {
              const res = bbFallback.write(bbSessionId, section, sectionData, node.agent, bbVersion);
              if (res.success) bbVersion = res.newVersion;
            }
          }
        }

        // Log cost (S28: include model)
        if (supabase && node.result.tokensInput) {
          const nodeAgent = getAgent(node.agent);
          logCost(supabase, {
            taskId: task.id,
            sprintId: task.sprint || undefined,
            agentRole: node.agent,
            agentName: node.result.agentName,
            tokensInput: node.result.tokensInput || 0,
            tokensOutput: node.result.tokensOutput || 0,
            costUsd: node.result.costUsd || 0,
            durationMs: node.result.durationMs,
            retryAttempt: node.result.retryCount || 0,
            context: "orchestration_parallel",
            model: nodeAgent?.model,
          }).catch(() => {});
        }
      }
    }

    supervisorReport = supervisor.generateReport();
  } else {
    // ── Sequential execution (existing behavior) ─────────────
    let stepIndex = 0;
    for (const agentId of pipeline) {
      // S33: Skip already completed steps on resume
      if (stepIndex < resumeFromStep) {
        stepIndex++;
        continue;
      }
      stepIndex++;

      const agent = getAgent(agentId);
      const agentLabel = agent
        ? `${agent.icon} ${agent.name} (${agent.title})`
        : agentId;

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
      const s38Enabled = isFeatureEnabled("inter_agent_messaging");
      if (s38Enabled && pipelineSessionId) {
        emitAgentEvent(supabase, pipelineSessionId, agentId, "spawned", {
          model: agent?.model, effort: agent?.effort, budget: agent?.maxBudgetUsd,
        }).catch(() => {});
      }

      // S22-04: Retry loop with exponential backoff
      let result: AgentStepResult | null = null;
      let retryCount = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // S38: Inject inter-agent messages into context
        let augmentedMessages = messages;
        if (s38Enabled && options.useBlackboard && bbSessionId) {
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

      // result is never null here because maxRetries >= 0 guarantees at least one iteration
      result!.retryCount = retryCount;
      steps.push(result!);

      // S38: Emit completed/failed event
      if (s38Enabled && pipelineSessionId) {
        const eventType = result!.success ? "completed" : "failed";
        emitAgentEvent(supabase, pipelineSessionId, agentId, eventType, {
          duration_ms: result!.durationMs,
          tokens_input: result!.tokensInput,
          tokens_output: result!.tokensOutput,
          cost_usd: result!.costUsd,
          ...(result!.error ? { error: result!.error } : {}),
        }).catch(() => {});
      }

      // S38: Detect conflicts in working memory after agent completes
      if (s38Enabled && options.useBlackboard && bbSessionId && result!.success) {
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
      if (s38Enabled && options.useBlackboard && bbSessionId && result!.success && supabase) {
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
              }).catch(() => {});
            }
          }
        } catch {
          // Clarification check is best-effort
        }
      }

      // S43: Deliberation protocol — reviewer challenges proposer
      if (result!.success && isFeatureEnabled("deliberation") && shouldDeliberate(agentId)) {
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

      // Log cost (S23-05, S28: include model)
      if (supabase && result!.tokensInput) {
        logCost(supabase, {
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
        }).catch(() => {});
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

  // S25: Attach parallel metrics
  if (options.parallel && supervisorReport) {
    orchestratedResult.parallelMetrics = {
      total_wall_time_ms: supervisorReport.total_wall_time_ms,
      sequential_equivalent_ms: supervisorReport.sequential_equivalent_ms,
      speedup_ratio: supervisorReport.speedup_ratio,
      per_agent_timing: supervisorReport.per_agent_timing,
      fan_out_count: fanOutCount,
      concurrent_peak: steps.length, // approximation
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
    step: "orchestration",
    from_step: "orchestration_start",
    to_step: "orchestration_end",
    metadata: {
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

// ── Dynamic Pipeline Selection (S22-06) ──────────────────────

/** Keywords that indicate a bug fix task */
const BUG_KEYWORDS = [
  "fix", "bug", "crash", "erreur", "error", "broken", "casse",
  "regression", "hotfix", "patch", "reparer", "corriger",
];

/** Keywords that indicate a review/QA task */
const REVIEW_KEYWORDS = [
  "review", "audit", "revue", "test", "qa", "qualite", "refactor",
  "nettoyage", "cleanup", "lint", "dette", "debt",
];

/** Keywords that indicate a documentation task */
const DOC_KEYWORDS = [
  "doc", "documentation", "readme", "changelog", "guide", "tutoriel",
];

export type PipelineType = "DEFAULT" | "QUICK" | "REVIEW" | "DOC";

/**
 * Analyze a task and select the most appropriate pipeline.
 *
 * Rules:
 *   - Bug/fix/patch/hotfix → QUICK (dev + qa)
 *   - Review/audit/refactor → REVIEW (qa + architect)
 *   - Documentation → QUICK (dev + qa)
 *   - Simple priority P3 with short title → QUICK
 *   - Everything else → DEFAULT (analyst + pm + architect + dev + qa)
 *   - Explicit override via options.pipeline always wins
 */
export function selectPipeline(
  task: Task,
  explicitPipeline?: AgentRole[]
): AgentRole[] {
  if (explicitPipeline) return explicitPipeline;

  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  if (BUG_KEYWORDS.some((kw) => text.includes(kw))) {
    return QUICK_PIPELINE;
  }

  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) {
    return REVIEW_PIPELINE;
  }

  if (DOC_KEYWORDS.some((kw) => text.includes(kw))) {
    return QUICK_PIPELINE;
  }

  // Simple tasks: short title, low priority, no subtasks
  if (
    task.priority >= 3 &&
    task.title.length < 40 &&
    (!task.subtasks || task.subtasks.length === 0)
  ) {
    return QUICK_PIPELINE;
  }

  return DEFAULT_PIPELINE;
}

/**
 * Classify a task into a pipeline type (for logging/display).
 */
export function classifyPipeline(task: Task): PipelineType {
  const text = `${task.title} ${task.description || ""}`.toLowerCase();

  if (BUG_KEYWORDS.some((kw) => text.includes(kw))) return "QUICK";
  if (REVIEW_KEYWORDS.some((kw) => text.includes(kw))) return "REVIEW";
  if (DOC_KEYWORDS.some((kw) => text.includes(kw))) return "DOC";
  if (
    task.priority >= 3 &&
    task.title.length < 40 &&
    (!task.subtasks || task.subtasks.length === 0)
  ) {
    return "QUICK";
  }
  return "DEFAULT";
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

  // S25: Parallel metrics
  if (result.parallelMetrics) {
    const pm = result.parallelMetrics;
    lines.push("");
    lines.push("--- Parallel Metrics ---");
    lines.push(`Wall time: ${Math.round(pm.total_wall_time_ms / 1000)}s`);
    lines.push(`Sequential equivalent: ${Math.round(pm.sequential_equivalent_ms / 1000)}s`);
    lines.push(`Speedup: ${pm.speedup_ratio.toFixed(2)}x`);
    if (pm.fan_out_count > 0) {
      lines.push(`Fan-out: ${pm.fan_out_count} agents`);
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
