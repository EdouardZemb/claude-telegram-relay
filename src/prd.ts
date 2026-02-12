/**
 * PRD (Product Requirements Document) Management
 *
 * Generates structured PRDs via Claude from user descriptions,
 * stores them in Supabase, and supports a validation workflow
 * (draft -> approved / rejected).
 *
 * Inspired by the BMad methodology: formalized artifacts,
 * gate-based workflow, validation before execution.
 */

import { spawn } from "bun";
import type { SupabaseClient } from "@supabase/supabase-js";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

export interface PRD {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  summary: string | null;
  content: string;
  project: string;
  status: "draft" | "approved" | "rejected" | "superseded";
  version: number;
  tags: string[];
  requested_by: string | null;
  metadata: Record<string, unknown>;
}

// ── PRD Template ─────────────────────────────────────────────

const PRD_TEMPLATE = `# PRD: {TITLE}

## Objectif
Quel probleme resout cette feature ? Pourquoi est-elle importante ?

## Contexte
Situation actuelle, limitations, et ce qui motive ce changement.

## Scope
### Inclus
- Ce qui sera fait dans cette iteration

### Exclus
- Ce qui est explicitement hors scope

## Specifications fonctionnelles
Description detaillee du comportement attendu.

## Specifications techniques
- Architecture / fichiers impactes
- Dependances
- Migrations DB si necessaire

## Criteres de succes
1. Critere mesurable 1
2. Critere mesurable 2

## Risques et mitigations
| Risque | Impact | Mitigation |
|--------|--------|------------|
| ...    | ...    | ...        |

## Plan d'implementation
1. Etape 1
2. Etape 2
3. Tests et validation

## Estimation
- Complexite: faible / moyenne / haute
- Taches estimees: N
`;

// ── Queries ──────────────────────────────────────────────────

export async function generatePRD(
  description: string,
  project: string = "telegram-relay"
): Promise<{ title: string; summary: string; content: string } | null> {
  const prompt = [
    "Tu es un product manager technique. Genere un PRD (Product Requirements Document) structure a partir de la description suivante.",
    "",
    `DESCRIPTION: ${description}`,
    `PROJET: ${project}`,
    "",
    "Utilise exactement ce template et remplis chaque section avec du contenu pertinent et concret :",
    "",
    PRD_TEMPLATE,
    "",
    "REGLES:",
    "- Sois concis mais precis",
    "- Les specs techniques doivent etre concretes (noms de fichiers, APIs, tables)",
    "- Les criteres de succes doivent etre mesurables",
    "- Le plan d'implementation doit etre decoupable en taches",
    "- N'utilise PAS de markdown gras (**) ni italique (*), juste du texte brut avec des titres #",
    "",
    "IMPORTANT: Commence ta reponse par une ligne JSON avec le titre et le resume, au format:",
    '{"title": "Titre court du PRD", "summary": "Resume en une phrase"}',
    "",
    "Puis le contenu complet du PRD.",
  ].join("\n");

  try {
    const args = [
      CLAUDE_PATH,
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ];

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: { ...process.env },
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Extract JSON metadata from first line
    const lines = output.trim().split("\n");
    let title = "PRD sans titre";
    let summary = "";
    let contentStart = 0;

    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      if (line.startsWith("{")) {
        try {
          const meta = JSON.parse(line);
          if (meta.title) title = meta.title;
          if (meta.summary) summary = meta.summary;
          contentStart = i + 1;
          break;
        } catch {
          // Not valid JSON, skip
        }
      }
    }

    const content = lines.slice(contentStart).join("\n").trim();
    if (!content) return null;

    return { title, summary, content };
  } catch (error) {
    console.error("generatePRD error:", error);
    return null;
  }
}

export async function savePRD(
  supabase: SupabaseClient,
  prd: { title: string; summary: string; content: string },
  opts?: { project?: string; tags?: string[]; requested_by?: string }
): Promise<PRD | null> {
  const { data, error } = await supabase
    .from("prds")
    .insert({
      title: prd.title,
      summary: prd.summary,
      content: prd.content,
      project: opts?.project ?? "telegram-relay",
      tags: opts?.tags ?? [],
      requested_by: opts?.requested_by ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("savePRD error:", error);
    return null;
  }
  return data as PRD;
}

export async function getPRD(
  supabase: SupabaseClient,
  idPrefix: string
): Promise<PRD | null> {
  const { data, error } = await supabase
    .from("prds")
    .select("*")
    .like("id", `${idPrefix}%`)
    .limit(1)
    .single();

  if (error) {
    console.error("getPRD error:", error);
    return null;
  }
  return data as PRD;
}

export async function getPRDs(
  supabase: SupabaseClient,
  opts?: { project?: string; status?: string }
): Promise<PRD[]> {
  let query = supabase
    .from("prds")
    .select("*")
    .order("created_at", { ascending: false });

  if (opts?.project) query = query.eq("project", opts.project);
  if (opts?.status) query = query.eq("status", opts.status);

  const { data, error } = await query;
  if (error) {
    console.error("getPRDs error:", error);
    return [];
  }
  return (data ?? []) as PRD[];
}

export async function updatePRDStatus(
  supabase: SupabaseClient,
  prdId: string,
  status: PRD["status"]
): Promise<PRD | null> {
  const { data, error } = await supabase
    .from("prds")
    .update({ status })
    .eq("id", prdId)
    .select()
    .single();

  if (error) {
    console.error("updatePRDStatus error:", error);
    return null;
  }
  return data as PRD;
}

// ── Formatting ───────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: "BROUILLON",
  approved: "APPROUVE",
  rejected: "REJETE",
  superseded: "REMPLACE",
};

export function formatPRDList(prds: PRD[]): string {
  if (prds.length === 0) return "Aucun PRD. Utilise /prd <description> pour en creer un.";

  const lines = ["PRDs", ""];

  for (const prd of prds) {
    const status = STATUS_LABELS[prd.status] || prd.status;
    const id = prd.id.substring(0, 8);
    const date = new Date(prd.created_at).toLocaleDateString("fr-FR");
    lines.push(`[${status}] ${prd.title}  [${id}]`);
    if (prd.summary) lines.push(`  ${prd.summary}`);
    lines.push(`  ${date} | ${prd.project} | v${prd.version}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function formatPRDDetail(prd: PRD): string {
  const status = STATUS_LABELS[prd.status] || prd.status;
  const header = [
    `PRD: ${prd.title}`,
    `Statut: ${status} | Projet: ${prd.project} | v${prd.version}`,
    `ID: ${prd.id.substring(0, 8)} | Cree le ${new Date(prd.created_at).toLocaleDateString("fr-FR")}`,
    "",
  ].join("\n");

  return header + prd.content;
}
