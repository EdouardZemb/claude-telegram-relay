/**
 * @module orchestrator.pipeline
 * @description Main orchestrate() function: multi-agent pipeline execution with
 * blackboard, gates, adversarial challenge, conformance, deliberation, overlap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { createLogger } from "../logger.ts";

const log = createLogger("orchestrator.pipeline");

import {
  type DriftReport,
  persistDriftReport,
  verifySpecVsImplementation,
} from "../adversarial-verifier.ts";
import { buildAgentContext } from "../agent-context.ts";
import { captureAgentFailure, clearInMemoryEvents, emitAgentEvent } from "../agent-events.ts";
import {
  type AgentInterMessage,
  buildInterAgentContext,
  canRequestClarification,
  checkPendingClarifications,
  clearClarificationTracker,
  detectConflicts,
  getAgentMessages,
  getMediatingAgent,
  markClarificationUsed,
  sendAgentMessage,
} from "../agent-messaging.ts";
import {
  type AgentMessage,
  formatExplorationPhaseOutput,
  parseAgentOutput,
  parseExplorationPhaseOutput,
} from "../agent-schemas.ts";
import {
  createBlackboard,
  generateTraceabilityReport,
  getFullBlackboard,
  InMemoryBlackboard,
  readSection,
  type SectionName,
  updateBlackboardStatus,
  type WorkingMemory,
  writeSection,
} from "../blackboard.ts";
import { getAgent } from "../bmad-agents.ts";
import { loadAgentYaml } from "../bmad-prompts.ts";
import { getDeliberationReviewer, runDeliberation, shouldDeliberate } from "../deliberation.ts";
import { buildTaskContext } from "../document-sharding.ts";
import { getFeedbackRulesForAgent } from "../feedback-loop.ts";
import { evaluateAndRework, type GateEvaluation, type GateName } from "../gate-evaluator.ts";
import { buildSpanId, logCostWithSpan, recordPromptVersion, sha256 } from "../llm-ops.ts";
import { classifyPipeline, DEFAULT_PIPELINE, selectPipeline } from "../pipeline-selection.ts";
import {
  buildResumeContext,
  createPipelineRun,
  loadPipelineState,
  type StepSnapshot,
  savePipelineStep,
  updatePipelineStatus,
} from "../pipeline-state.ts";
import { buildStoryFile, enrichTaskWithStory } from "../story-files.ts";
import type { Task } from "../tasks.ts";
import { WorkflowTracker } from "../workflow.ts";
import { persistAgentArtifact, runAgentStep } from "./agent-step.ts";
import { buildOrchestrationSummary, logOrchestrationResult } from "./format.ts";
import type {
  AgentRole,
  AgentStepResult,
  OrchestratedResult,
  OrchestrateOptions,
} from "./types.ts";

/**
 * Orchestrate a task through a pipeline of BMad agents.
 *
 * Each agent receives structured outputs of all previous agents as context.
 * S22: Retry loop, structured message passing, dynamic pipeline selection.
 */
export async function orchestrate(
  supabase: SupabaseClient | null,
  task: Task,
  options: OrchestrateOptions = {},
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
          `Resume pipeline depuis l'etape ${resumeFromStep} (${ctx.previousMessages.length} agents deja completes)`,
        );
      }
      // Messages will be loaded below after pipeline selection
    }
  }

  // Dynamic pipeline selection (S22-06)
  const pipeline = options.autoPipeline
    ? selectPipeline(task, options.pipeline)
    : options.pipeline || DEFAULT_PIPELINE;
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
        4000, // token budget
      );
    } catch {
      // R7: optional feature -> skip
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
      }),
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
    const { data: refreshed } = await supabase.from("tasks").select("*").eq("id", task.id).single();
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
      `Orchestration demarree (${pipelineLabel}) : ${agentNames.join(" -> ")}`,
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
    await createPipelineRun(supabase, task.id, pipelineSessionId, classifyPipeline(task), pipeline);
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
        task.project_id || undefined,
      );
      if (!bb) {
        // EC-008: fallback to in-memory
        log.warn("Supabase blackboard creation failed, using in-memory fallback");
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
      "spec-template.md",
    );
    try {
      const template = readFileSync(specTemplatePath, "utf-8");
      if (supabase && !bbFallback) {
        const res = await writeSection(
          supabase,
          bbSessionId,
          "spec",
          { template, task_title: task.title, task_description: task.description },
          "system",
          bbVersion,
        );
        if (res.success) bbVersion = res.newVersion;
      } else if (bbFallback) {
        const res = bbFallback.write(
          bbSessionId,
          "spec",
          { template, task_title: task.title, task_description: task.description },
          "system",
          bbVersion,
        );
        if (res.success) bbVersion = res.newVersion;
      }
    } catch {
      // R7: optional feature -> skip
    }

    if (options.onProgress) {
      await options.onProgress(
        "Blackboard initialise" + (bbFallback ? " (in-memory fallback)" : ""),
      );
    }
  }

  // Resolve overlap + blackboard incompatibility
  let effectiveOverlap = options.overlap ?? false;
  if (effectiveOverlap && options.useBlackboard) {
    log.warn("overlap is incompatible with useBlackboard, falling back to sequential");
    effectiveOverlap = false;
  }

  // ── Sequential execution (with optional overlap for last 2 agents) ──
  {
    // P1: Determine which agents run sequentially vs in parallel
    const overlapThreshold =
      effectiveOverlap && pipeline.length >= 2
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
      const agentLabel = agent ? `${agent.icon} ${agent.name} (${agent.title})` : agentId;

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
          // R6: optional IO -> degrade gracefully
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
          model: agent?.model,
          effort: agent?.effort,
        }).catch((err) => log.error(`emitAgentEvent spawned error: ${err}`));
      }

      // S22-04: Retry loop with exponential backoff
      let result: AgentStepResult | null = null;
      let retryCount = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // S38: Inject inter-agent messages into context
        const augmentedMessages = messages;
        if (options.useBlackboard && bbSessionId) {
          const interMessages = await getAgentMessages(supabase, bbSessionId, agentId);
          if (interMessages.length > 0) {
            const interCtx = buildInterAgentContext(interMessages, agentId);
            // Append inter-agent context to agent context
            const existingCtx = agentContextCache.get(agentId) || "";
            agentContextCache.set(agentId, existingCtx + "\n\n" + interCtx);
          }
        }

        result = await runAgentStep(
          agentId,
          task,
          augmentedMessages,
          shardedContext,
          agentContextCache.get(agentId),
          options.modelOverrides?.[agentId],
          options.cascade,
        );

        if (result.success) break;

        if (attempt < maxRetries) {
          retryCount = attempt + 1;
          const backoffMs = Math.min(1000 * 2 ** attempt, 30000);
          if (options.onProgress) {
            await options.onProgress(
              `${agentLabel} echoue, retry ${retryCount}/${maxRetries} dans ${backoffMs / 1000}s...`,
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
        }).catch((err) => log.error(`captureAgentFailure error: ${err}`));
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
        }).catch((err) => log.error(`emitAgentEvent completed/failed error: ${err}`));
      }

      // S38: Detect conflicts in working memory after agent completes
      if (options.useBlackboard && bbSessionId && result!.success) {
        try {
          const wm =
            supabase && !bbFallback
              ? ((await readSection(
                  supabase,
                  bbSessionId,
                  "working_memory",
                )) as WorkingMemory | null)
              : (bbFallback?.read(bbSessionId, "working_memory") as WorkingMemory | null);
          const conflicts = detectConflicts(wm);
          for (const conflict of conflicts) {
            if (options.onProgress) {
              await options.onProgress(
                `Conflit detecte: ${conflict.agent1} vs ${conflict.agent2} sur "${conflict.subject.substring(0, 50)}"`,
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
          // R7: optional feature -> skip
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
                  `Clarification: ${q.from} demande a ${q.to}: ${q.content.substring(0, 60)}...`,
                );
              }
              emitAgentEvent(supabase, pipelineSessionId!, q.from, "clarification_requested", {
                target_agent: q.to,
                question: q.content.substring(0, 200),
              }).catch((err) => log.error(`emitAgentEvent clarification error: ${err}`));
            }
          }
        } catch {
          // R7: optional feature -> skip
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
              agentContextCache.set(
                remainingRole,
                existing + "\n\nRAPPORT EXPLORATION:\n" + formattedReport,
              );
            }
          }

          // Write to blackboard if enabled
          if (bbSessionId) {
            const explorationData = explorationReport || {
              raw: result!.output.substring(0, 10000),
            };
            if (supabase && !bbFallback) {
              const currentSpec = (await readSection(supabase, bbSessionId, "spec")) || {};
              const res = await writeSection(
                supabase,
                bbSessionId,
                "spec",
                { ...currentSpec, exploration: explorationData },
                "explorer",
                bbVersion,
              );
              if (res.success) bbVersion = res.newVersion;
            } else if (bbFallback) {
              const currentSpec = bbFallback.read(bbSessionId, "spec") || {};
              const res = bbFallback.write(
                bbSessionId,
                "spec",
                { ...currentSpec, exploration: explorationData },
                "explorer",
                bbVersion,
              );
              if (res.success) bbVersion = res.newVersion;
            }
          }
        } catch {
          // R7: optional feature -> skip
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
          const sectionData = (result!.structured || {
            raw: result!.output.substring(0, 30000),
          }) as Record<string, unknown>;
          if (supabase && !bbFallback) {
            const res = await writeSection(
              supabase,
              bbSessionId,
              section,
              sectionData,
              agentId,
              bbVersion,
            );
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
                const reworkMessages = [
                  ...messages,
                  {
                    agentId,
                    agentName: result!.agentName,
                    success: false,
                    structured: null,
                    rawOutput: feedback,
                    durationMs: 0,
                  },
                ];
                const reworkResult = await runAgentStep(
                  agentId,
                  task,
                  reworkMessages,
                  shardedContext,
                  agentContextCache.get(agentId),
                  options.modelOverrides?.[agentId],
                  options.cascade,
                );
                if (reworkResult.success) {
                  const newData = (reworkResult.structured || {
                    raw: reworkResult.output.substring(0, 30000),
                  }) as Record<string, unknown>;
                  // Update blackboard with reworked output
                  if (supabase && !bbFallback) {
                    const res = await writeSection(
                      supabase,
                      bbSessionId,
                      section,
                      newData,
                      agentId,
                      bbVersion,
                    );
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
                return (reworkResult.structured || {
                  raw: reworkResult.output.substring(0, 30000),
                }) as Record<string, unknown>;
              },
              {
                maxIterations: 2,
                taskId: task.id,
                sprintId: task.sprint || undefined,
                taskPriority: task.priority,
              },
            );
            gateEvaluations.push(reworkResult.finalEvaluation);
            if (options.onProgress) {
              const status = reworkResult.finalEvaluation.pass ? "PASS" : "FAIL";
              const reworkNote =
                reworkResult.iterations > 0 ? ` (${reworkResult.iterations} rework)` : "";
              await options.onProgress(
                `Gate ${gate}: ${status} (${reworkResult.finalEvaluation.score}/100)${reworkNote}`,
              );
            }
          }
        }
      }

      // Log cost with span attribution (S23-05, S28, LLM-Ops R4/R8)
      if (supabase && result!.tokensInput) {
        const spanId = pipelineSessionId
          ? buildSpanId(pipelineSessionId, agentId, stepIndex - 1)
          : "";
        logCostWithSpan(
          supabase,
          {
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
          },
          spanId,
          pipelineSessionId || "",
        ).catch((err) => log.error(`logCost orchestration error: ${err}`));
      }

      // LLM-Ops: record prompt version (R3, R11 — fire-and-forget)
      if (supabase && pipelineSessionId) {
        const yaml = loadAgentYaml(agentId);
        const yamlContent = yaml ? JSON.stringify(yaml) : "";
        const templateH = sha256(yamlContent);
        const feedbackRules = getFeedbackRulesForAgent(agentId as AgentRole);
        const feedbackH = sha256(JSON.stringify(feedbackRules));
        recordPromptVersion(supabase, agentId, templateH, feedbackH).catch((err) =>
          log.error(`recordPromptVersion error: ${err}`),
        );
      }

      if (options.onProgress) {
        const status = result!.success ? "OK" : "ECHEC";
        const duration = Math.round(result!.durationMs / 1000);
        const retryInfo = retryCount > 0 ? ` (${retryCount} retries)` : "";
        await options.onProgress(`${agentLabel} : ${status} (${duration}s)${retryInfo}`);
      }

      // Log checkpoint (S22-05: include retry metrics)
      if (tracker) {
        await tracker.logCheckpoint(
          result!.success ? "pass" : "fail",
          `Agent ${agentId}: ${result!.success ? "succes" : "echec"} en ${result!.durationMs}ms` +
            (retryCount > 0 ? ` (${retryCount} retries)` : ""),
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
              (pipelineSessionId ? ` Reprendre avec --resume ${pipelineSessionId}` : ""),
          );
        }
        break;
      }
    }

    // P1: Overlap execution — run last 2 agents in parallel (R1, R1b, R1d)
    if (effectiveOverlap && pipeline.length >= 2) {
      // Only run overlap if sequential part didn't fail with stopOnFailure
      const lastFailed =
        steps.length > 0 && !steps[steps.length - 1].success && options.stopOnFailure;
      if (!lastFailed) {
        const overlapAgents = pipeline.slice(overlapThreshold);
        const previousMessagesSnapshot = [...messages]; // R1d: frozen snapshot

        const overlapPromises = overlapAgents.map(async (agentId) => {
          const agent = getAgent(agentId);
          const agentLabel = agent ? `${agent.icon} ${agent.name} (${agent.title})` : agentId;

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
              // R6: optional IO -> degrade gracefully
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
              model: agent?.model,
              effort: agent?.effort,
              overlap: true,
            }).catch((err) => log.error(`emitAgentEvent spawned error: ${err}`));
          }

          // Retry loop for overlap agent
          let result: AgentStepResult | null = null;
          let retryCount = 0;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            result = await runAgentStep(
              agentId,
              task,
              previousMessagesSnapshot,
              shardedContext,
              agentContextCache.get(agentId),
              options.modelOverrides?.[agentId],
              options.cascade,
            );
            if (result.success) break;
            if (attempt < maxRetries) {
              retryCount = attempt + 1;
              const backoffMs = Math.min(1000 * 2 ** attempt, 30000);
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
            }).catch((err) => log.error(`captureAgentFailure error: ${err}`));
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
            }).catch((err) => log.error(`emitAgentEvent error: ${err}`));
          }

          // Log cost with span attribution (LLM-Ops R4/R8)
          if (supabase && result!.tokensInput) {
            const overlapStepIdx = pipeline.indexOf(agentId);
            const spanId = pipelineSessionId
              ? buildSpanId(pipelineSessionId, agentId, overlapStepIdx)
              : "";
            logCostWithSpan(
              supabase,
              {
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
                metadata: pipelineSessionId
                  ? { pipeline_session_id: pipelineSessionId }
                  : undefined,
              },
              spanId,
              pipelineSessionId || "",
            ).catch((err) => log.error(`logCost orchestration error: ${err}`));
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
            log.error(`orchestrate overlap: unexpected rejection ${outcome.reason}`);
          }
        }

        // R1b: Check if any overlap agent failed with stopOnFailure
        if (options.stopOnFailure) {
          const overlapFailed = steps.slice(-overlapAgents.length).some((s) => !s.success);
          if (overlapFailed && pipelineSessionId) {
            const failedStep = steps.find((s) => !s.success);
            await updatePipelineStatus(supabase, pipelineSessionId, "failed", failedStep?.error);
            if (options.onProgress) {
              await options.onProgress(
                `Pipeline arrete: agent en overlap a echoue.` +
                  (pipelineSessionId ? ` Reprendre avec --resume ${pipelineSessionId}` : ""),
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

      let spec: Record<string, unknown> | null = null;
      let impl: Record<string, unknown> | null = null;
      if (supabase && !bbFallback) {
        spec = (await readSection(supabase, bbSessionId, "spec")) as Record<string, unknown> | null;
        impl = (await readSection(supabase, bbSessionId, "implementation")) as Record<
          string,
          unknown
        > | null;
      } else if (bbFallback) {
        spec = bbFallback.read(bbSessionId, "spec") as Record<string, unknown> | null;
        impl = bbFallback.read(bbSessionId, "implementation") as Record<string, unknown> | null;
      }

      driftReport = await verifySpecVsImplementation(spec, impl, pipelineTypeLabel);

      if (driftReport && supabase) {
        await persistDriftReport(supabase, bbSessionId, task.id, driftReport);
      }

      if (options.onProgress && driftReport) {
        await options.onProgress(
          `Adversarial verification: ${driftReport.coverage_score}% coverage — ${driftReport.overall_verdict.toUpperCase()}`,
        );
      }
    }

    // Traceability report
    let sections: import("../blackboard.ts").BlackboardSections | null = null;
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
          `Traceability: ${traceabilityReport.coverage_percentage}% FR coverage`,
        );
      }
    }

    // Mark blackboard as completed
    if (supabase && !bbFallback) {
      await updateBlackboardStatus(
        supabase,
        bbSessionId,
        steps.every((s) => s.success) ? "completed" : "failed",
      );
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
