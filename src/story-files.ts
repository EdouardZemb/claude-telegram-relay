/**
 * Story Files — S16-02
 *
 * Generates structured story files for tasks, following BMad methodology.
 * A story file contains: acceptance criteria, test stubs, implementation steps,
 * and done criteria. The Dev agent loads this instead of a bare task title.
 *
 * Story files are stored as JSON in the task's dev_notes field and can also
 * be written to disk for the agent to read during /exec.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, Subtask } from "./tasks.ts";
import { getAgent } from "./bmad-agents.ts";

// ── Types ────────────────────────────────────────────────────

export interface StoryFile {
  /** Task title */
  title: string;
  /** Story description for the dev agent */
  description: string;
  /** Structured acceptance criteria */
  acceptanceCriteria: AcceptanceCriterion[];
  /** Implementation subtasks in order */
  implementationSteps: ImplementationStep[];
  /** Test stubs — what needs to be tested */
  testStubs: TestStub[];
  /** Definition of done */
  doneCriteria: string[];
  /** Files likely to be impacted */
  impactedFiles: string[];
  /** Architecture notes / references */
  architectureNotes: string;
}

export interface AcceptanceCriterion {
  id: string; // AC-1, AC-2, etc.
  given: string;
  when: string;
  then: string;
}

export interface ImplementationStep {
  id: string; // STEP-1, STEP-2, etc.
  title: string;
  description: string;
  acMapping: string[]; // Which ACs this step covers
  done: boolean;
}

export interface TestStub {
  id: string; // TEST-1, TEST-2, etc.
  description: string;
  type: "unit" | "integration" | "e2e";
  acMapping: string; // Which AC this test covers
}

// ── Story File Builder ───────────────────────────────────────

/**
 * Build a story file from a task and its context.
 * Uses the task's existing fields (description, AC, subtasks) as input,
 * and structures them into a standardized format.
 */
export function buildStoryFile(task: Task): StoryFile {
  // Parse existing acceptance criteria into structured form
  const acceptanceCriteria = parseAcceptanceCriteria(
    task.acceptance_criteria || ""
  );

  // Convert existing subtasks to implementation steps
  const implementationSteps = buildImplementationSteps(
    task.subtasks || [],
    acceptanceCriteria
  );

  // Generate test stubs from ACs
  const testStubs = generateTestStubs(acceptanceCriteria);

  // Build done criteria
  const doneCriteria = buildDoneCriteria(acceptanceCriteria, testStubs);

  return {
    title: task.title,
    description: task.description || task.title,
    acceptanceCriteria,
    implementationSteps,
    testStubs,
    doneCriteria,
    impactedFiles: extractImpactedFiles(task),
    architectureNotes: task.architecture_ref || "",
  };
}

/**
 * Format a story file as a readable text prompt for the Dev agent.
 */
export function formatStoryForAgent(story: StoryFile): string {
  const lines: string[] = [];

  // Header
  lines.push(`STORY FILE: ${story.title}`);
  lines.push("=".repeat(60));
  lines.push("");

  // Description
  lines.push("DESCRIPTION:");
  lines.push(story.description);
  lines.push("");

  // Acceptance Criteria
  if (story.acceptanceCriteria.length > 0) {
    lines.push("CRITERES D'ACCEPTATION:");
    for (const ac of story.acceptanceCriteria) {
      lines.push(`  ${ac.id}:`);
      lines.push(`    GIVEN: ${ac.given}`);
      lines.push(`    WHEN: ${ac.when}`);
      lines.push(`    THEN: ${ac.then}`);
    }
    lines.push("");
  }

  // Implementation Steps
  if (story.implementationSteps.length > 0) {
    lines.push("ETAPES D'IMPLEMENTATION (a executer dans l'ordre):");
    for (const step of story.implementationSteps) {
      const checkbox = step.done ? "[x]" : "[ ]";
      const acRef = step.acMapping.length > 0
        ? ` (couvre: ${step.acMapping.join(", ")})`
        : "";
      lines.push(`  ${checkbox} ${step.id}: ${step.title}${acRef}`);
      if (step.description) {
        lines.push(`       ${step.description}`);
      }
    }
    lines.push("");
  }

  // Test Stubs
  if (story.testStubs.length > 0) {
    lines.push("TESTS REQUIS:");
    for (const test of story.testStubs) {
      lines.push(`  ${test.id} [${test.type}] ${test.description} (${test.acMapping})`);
    }
    lines.push("");
  }

  // Done Criteria
  if (story.doneCriteria.length > 0) {
    lines.push("DEFINITION OF DONE:");
    for (const criterion of story.doneCriteria) {
      lines.push(`  [ ] ${criterion}`);
    }
    lines.push("");
  }

  // Impacted Files
  if (story.impactedFiles.length > 0) {
    lines.push("FICHIERS IMPACTES:");
    for (const file of story.impactedFiles) {
      lines.push(`  ${file}`);
    }
    lines.push("");
  }

  // Architecture Notes
  if (story.architectureNotes) {
    lines.push("NOTES ARCHITECTURE:");
    lines.push(story.architectureNotes);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Enrich a task with a generated story file.
 * Stores the formatted story in dev_notes and structured ACs.
 */
export async function enrichTaskWithStory(
  supabase: SupabaseClient,
  taskId: string,
  story: StoryFile
): Promise<boolean> {
  const formattedStory = formatStoryForAgent(story);
  const subtasks: Subtask[] = story.implementationSteps.map((step) => ({
    title: step.title,
    ac_mapping: step.acMapping.join(", "),
    done: step.done,
  }));

  const acText = story.acceptanceCriteria
    .map((ac) => `${ac.id}: Given ${ac.given}, When ${ac.when}, Then ${ac.then}`)
    .join("\n");

  const { error } = await supabase
    .from("tasks")
    .update({
      dev_notes: formattedStory,
      acceptance_criteria: acText || null,
      subtasks,
    })
    .eq("id", taskId);

  if (error) {
    console.error("enrichTaskWithStory error:", error);
    return false;
  }
  return true;
}

// ── Parsers / Generators ─────────────────────────────────────

/**
 * Parse raw acceptance criteria text into structured Given/When/Then.
 * Supports various formats:
 *   - "Given X, When Y, Then Z"
 *   - "- User can login" (simple bullet → converted)
 *   - Multi-line blocks
 */
function parseAcceptanceCriteria(raw: string): AcceptanceCriterion[] {
  if (!raw.trim()) return [];

  const criteria: AcceptanceCriterion[] = [];
  let index = 1;

  // Try to parse Given/When/Then format
  const gwtPattern = /(?:Given|GIVEN)\s+(.+?)[\s,]*(?:When|WHEN)\s+(.+?)[\s,]*(?:Then|THEN)\s+(.+?)(?:\n|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = gwtPattern.exec(raw)) !== null) {
    criteria.push({
      id: `AC-${index}`,
      given: match[1].trim(),
      when: match[2].trim(),
      then: match[3].trim(),
    });
    index++;
  }

  // If no GWT format found, convert simple bullets to ACs
  if (criteria.length === 0) {
    const bullets = raw
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter((l) => l.length > 0);

    for (const bullet of bullets) {
      criteria.push({
        id: `AC-${index}`,
        given: "the system is in its default state",
        when: `the user performs: ${bullet}`,
        then: "the expected behavior occurs as described",
      });
      index++;
    }
  }

  return criteria;
}

function buildImplementationSteps(
  subtasks: Subtask[],
  acs: AcceptanceCriterion[]
): ImplementationStep[] {
  if (subtasks.length > 0) {
    return subtasks.map((st, i) => ({
      id: `STEP-${i + 1}`,
      title: st.title,
      description: "",
      acMapping: st.ac_mapping
        ? st.ac_mapping.split(",").map((s) => s.trim())
        : acs.length > 0
        ? [acs[Math.min(i, acs.length - 1)].id]
        : [],
      done: st.done || false,
    }));
  }

  // If no subtasks exist, create one step per AC
  return acs.map((ac, i) => ({
    id: `STEP-${i + 1}`,
    title: `Implementer ${ac.id}`,
    description: `${ac.when} -> ${ac.then}`,
    acMapping: [ac.id],
    done: false,
  }));
}

function generateTestStubs(acs: AcceptanceCriterion[]): TestStub[] {
  return acs.map((ac, i) => ({
    id: `TEST-${i + 1}`,
    description: `Verifie que: ${ac.then}`,
    type: "unit" as const,
    acMapping: ac.id,
  }));
}

function buildDoneCriteria(
  acs: AcceptanceCriterion[],
  tests: TestStub[]
): string[] {
  const criteria: string[] = [];
  criteria.push("Tous les tests existants passent (bun test)");
  if (tests.length > 0) {
    criteria.push(`${tests.length} nouveaux tests ecrits et passent`);
  }
  for (const ac of acs) {
    criteria.push(`${ac.id} verifie et fonctionnel`);
  }
  criteria.push("Code revue et pret pour merge");
  return criteria;
}

function extractImpactedFiles(task: Task): string[] {
  const files: string[] = [];
  // Extract file paths from description and notes
  const combined = [task.description, task.dev_notes, task.architecture_ref]
    .filter(Boolean)
    .join("\n");

  const pathPattern = /(?:src|tests|config|db|dashboard)\/[\w/.%-]+\.\w+/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(combined)) !== null) {
    if (!files.includes(match[0])) {
      files.push(match[0]);
    }
  }

  return files;
}

// ── Format for Telegram ──────────────────────────────────────

export function formatStoryPreview(story: StoryFile): string {
  const lines: string[] = [];
  lines.push(`Story: ${story.title}`);
  lines.push(`ACs: ${story.acceptanceCriteria.length}`);
  lines.push(`Steps: ${story.implementationSteps.length}`);
  lines.push(`Tests: ${story.testStubs.length}`);

  if (story.acceptanceCriteria.length > 0) {
    lines.push("");
    lines.push("Criteres:");
    for (const ac of story.acceptanceCriteria.slice(0, 3)) {
      lines.push(`  ${ac.id}: ${ac.when} -> ${ac.then}`);
    }
    if (story.acceptanceCriteria.length > 3) {
      lines.push(`  ... +${story.acceptanceCriteria.length - 3} autres`);
    }
  }

  return lines.join("\n");
}
