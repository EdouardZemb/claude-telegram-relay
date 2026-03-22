/**
 * @module documents
 * @description Document management: text extraction (Claude CLI + pdf-parse),
 * LLM classification (Claude CLI) with dynamic categories, CRUD with Supabase Storage,
 * semantic search via Edge Function. S45-T2.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

// ── Types ────────────────────────────────────────────────────

export interface DocumentCategory {
  id: string;
  name: string;
  description: string | null;
  usage_count: number;
  created_by: string;
  created_at: string;
}

export interface Document {
  id: string;
  user_id: string;
  project_id: string | null;
  category_id: string | null;
  title: string | null;
  extracted_text: string | null;
  description: string | null;
  document_date: string | null;
  file_path: string;
  file_type: string;
  file_size: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DocumentCreateInput {
  userId: string;
  projectId?: string | undefined;
  title?: string | undefined;
  filePath: string;
  fileType: string;
  fileSize?: number | undefined;
  buffer: Buffer;
}

export interface ClassificationResult {
  category_id: string;
  category_name: string;
  confidence: number;
  description: string;
  document_date: string | null;
  is_new_category: boolean;
  suggested_title: string | null;
}

export interface DocumentSearchResult {
  id: string;
  title: string | null;
  extracted_text: string | null;
  description: string | null;
  document_date: string | null;
  category_id: string | null;
  created_at: string;
  similarity: number;
  file_path: string | null;
}

export interface ListDocumentsOptions {
  categoryId?: string;
  limit?: number;
  offset?: number;
}

// ── Constants ────────────────────────────────────────────────

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const NEW_CATEGORY_CONFIDENCE_THRESHOLD = 0.6;
const STORAGE_BUCKET = "documents";

// ── CLI Helper ───────────────────────────────────────────────

/**
 * Call Claude CLI with a prompt. Uses Max subscription (no API key needed).
 */
async function callClaudeCLI(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--dangerously-skip-permissions"];

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY"].includes(k),
    ),
  );

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: cleanEnv });
  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Claude CLI error: ${stderr || "exit code " + exitCode}`);
  }

  return output.trim();
}

// ── Text Extraction ──────────────────────────────────────────

/**
 * Extract text from an image using Claude CLI (reads the file via its Read tool).
 */
export async function extractTextFromImage(
  buffer: Buffer,
  fileType: string,
): Promise<string> {
  const ext = fileType === "image/png" ? "png"
    : fileType === "image/webp" ? "webp"
    : fileType === "image/gif" ? "gif"
    : fileType === "application/pdf" ? "pdf"
    : "jpg";
  const tmpPath = join(tmpdir(), `doc-extract-${Date.now()}.${ext}`);

  try {
    await writeFile(tmpPath, buffer);
    const result = await callClaudeCLI(
      `Read the file at ${tmpPath} and extract ALL text visible in it. If the document contains tables, preserve the tabular structure using aligned columns or a simple delimiter (pipe | or tab). Extract every row and column — do not summarize or skip repeated rows. Return ONLY the raw extracted text, no commentary. If there is no text, return an empty string.`,
    );
    return result;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Convert PDF pages to PNG images using pdftoppm, then extract text
 * from each page using Claude Vision. Much more reliable for tables.
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // First try pdf-parse for simple text PDFs (fast path)
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse(new Uint8Array(buffer));
    await (parser as any).load();
    const result = await parser.getText();
    const text = (typeof result === "string" ? result : result?.text ?? "").trim();
    if (text.length > 50) {
      // Check that text has a reasonable ratio of alphanumeric chars (not garbled binary)
      const alnumCount = (text.substring(0, 500).match(/[\p{L}\p{N}]/gu) || []).length;
      const ratio = alnumCount / Math.min(text.length, 500);
      if (ratio > 0.3) {
        console.log(`pdf-parse OK: ${text.length} chars, alnum ratio ${ratio.toFixed(2)}`);
        return text;
      }
      console.log(`pdf-parse rejected: alnum ratio too low (${ratio.toFixed(2)}), using Vision`);
    } else {
      console.log(`pdf-parse too short (${text.length} chars), using Vision`);
    }
  } catch (e) {
    console.error("pdf-parse failed, using Vision pipeline:", e);
  }

  // Vision fallback: convert PDF to PNG images via pdftoppm, then extract via Claude Vision
  console.log("Starting pdftoppm + Vision extraction for PDF...");
  const tmpPdf = join(tmpdir(), `doc-pdf-${Date.now()}.pdf`);
  const tmpPrefix = join(tmpdir(), `doc-page-${Date.now()}`);

  try {
    await writeFile(tmpPdf, buffer);

    // Convert PDF pages to PNG at 300 DPI (max 10 pages)
    const proc = Bun.spawn(
      ["pdftoppm", "-png", "-r", "300", "-l", "10", tmpPdf, tmpPrefix],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;

    // Find generated page images
    const { readdir } = await import("fs/promises");
    const dir = tmpdir();
    const prefix = `doc-page-${tmpPrefix.split("doc-page-")[1]}`;
    const allFiles = await readdir(dir);
    const pageFiles = allFiles
      .filter((f) => f.startsWith(prefix.split("/").pop()!) && f.endsWith(".png"))
      .sort();

    if (pageFiles.length === 0) {
      console.log("pdftoppm produced no pages, falling back to direct PDF read");
      return extractTextFromImage(buffer, "application/pdf");
    }

    console.log(`pdftoppm produced ${pageFiles.length} page(s)`);

    // Extract text from each page image via Claude Vision
    const pageTexts: string[] = [];
    for (const pageFile of pageFiles) {
      const pagePath = join(dir, pageFile);
      try {
        const text = await callClaudeCLI(
          `Read the file at ${pagePath} and extract ALL text visible in it. If the document contains tables, preserve the tabular structure using aligned columns or a simple delimiter (pipe | or tab). Extract every row and column — do not summarize or skip repeated rows. Return ONLY the raw extracted text, no commentary. If there is no text, return an empty string.`,
        );
        if (text) pageTexts.push(text);
      } finally {
        await unlink(pagePath).catch(() => {});
      }
    }

    const combined = pageTexts.join("\n\n--- Page suivante ---\n\n").trim();
    if (combined.length > 0) {
      console.log(`Vision extraction OK: ${combined.length} chars from ${pageFiles.length} page(s)`);
      return combined;
    }

    console.log("Vision extraction returned empty, falling back to direct PDF read");
    return extractTextFromImage(buffer, "application/pdf");
  } finally {
    await unlink(tmpPdf).catch(() => {});
  }
}

/**
 * Dispatch text extraction based on file type.
 */
export async function extractText(
  buffer: Buffer,
  fileType: string,
): Promise<string> {
  if (fileType === "application/pdf") {
    return extractTextFromPDF(buffer);
  }
  if (fileType.startsWith("image/")) {
    return extractTextFromImage(buffer, fileType);
  }
  throw new Error(`Unsupported file type for extraction: ${fileType}`);
}

// ── Categories ───────────────────────────────────────────────

/**
 * Fetch all document categories from Supabase.
 */
export async function getCategories(
  supabase: SupabaseClient,
): Promise<DocumentCategory[]> {
  const { data, error } = await supabase
    .from("document_categories")
    .select("*")
    .order("usage_count", { ascending: false });

  if (error) {
    console.error("getCategories error:", error);
    return [];
  }
  return data || [];
}

/**
 * Get or create a category by name. Returns category ID.
 */
export async function getOrCreateCategory(
  supabase: SupabaseClient,
  name: string,
  description?: string,
): Promise<string> {
  // Try to find existing
  const { data: existing } = await supabase
    .from("document_categories")
    .select("id")
    .eq("name", name.toLowerCase())
    .single();

  if (existing) return existing.id;

  // Create new
  const { data: created, error } = await supabase
    .from("document_categories")
    .insert({
      name: name.toLowerCase(),
      description: description || null,
      created_by: "llm",
    })
    .select("id")
    .single();

  if (error) {
    console.error("getOrCreateCategory error:", error);
    throw new Error(`Failed to create category: ${error.message}`);
  }
  return created!.id;
}

// ── Classification ───────────────────────────────────────────

/**
 * Classify a document using Claude CLI with dynamic categories.
 * If confidence < 0.6, creates a new category.
 */
export async function classifyDocument(
  supabase: SupabaseClient,
  text: string,
  categories: DocumentCategory[],
): Promise<ClassificationResult> {
  const categoryList = categories
    .map((c) => `- ${c.name}: ${c.description || "pas de description"}`)
    .join("\n");

  const prompt = `Tu es un classifieur de documents. Analyse le texte suivant et classe-le dans une des categories existantes, ou propose une nouvelle categorie si aucune ne convient.

CATEGORIES EXISTANTES:
${categoryList}

TEXTE DU DOCUMENT (premiers 2000 caracteres):
${text.substring(0, 2000)}

Reponds UNIQUEMENT en JSON valide, sans aucun autre texte:
{
  "category_name": "nom de la categorie (existante ou nouvelle)",
  "confidence": 0.0 a 1.0,
  "description": "description courte du document en une phrase",
  "document_date": "YYYY-MM-DD ou null si pas de date detectee",
  "suggested_title": "titre suggere pour le document"
}`;

  const rawText = await callClaudeCLI(prompt);

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Classification returned invalid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const categoryName = (parsed.category_name || "note").toLowerCase();
  const confidence = Math.max(0, Math.min(1, parsed.confidence || 0));
  const description = parsed.description || "";
  const documentDate = parsed.document_date || null;
  const suggestedTitle = parsed.suggested_title || null;

  // Check if category exists
  const existingCategory = categories.find(
    (c) => c.name.toLowerCase() === categoryName,
  );

  let categoryId: string;
  let isNewCategory = false;

  if (existingCategory && confidence >= NEW_CATEGORY_CONFIDENCE_THRESHOLD) {
    categoryId = existingCategory.id;
  } else if (!existingCategory) {
    // New category needed
    categoryId = await getOrCreateCategory(supabase, categoryName, description);
    isNewCategory = true;
  } else {
    // Low confidence on existing category — still use it but flag
    categoryId = existingCategory.id;
  }

  // Bump usage count (fire-and-forget)
  supabase
    .from("document_categories")
    .update({ usage_count: (existingCategory?.usage_count || 0) + 1 })
    .eq("id", categoryId)
    .then(() => {}, (e: unknown) => console.error("usage_count bump error:", e));

  return {
    category_id: categoryId,
    category_name: categoryName,
    confidence,
    description,
    document_date: documentDate,
    is_new_category: isNewCategory,
    suggested_title: suggestedTitle,
  };
}

// ── Duplicate Detection ─────────────────────────────────────

/**
 * Compute SHA-256 hash of a file buffer.
 */
export function computeFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export interface DuplicateCheckResult {
  found: boolean;
  matchType: "filename" | "content" | null;
  existingDocument: Document | null;
}

/**
 * Check if a document already exists for this user by filename or content hash.
 * Returns the existing document and match type if found.
 */
export async function checkDuplicate(
  supabase: SupabaseClient,
  userId: string,
  filename: string,
  contentHash: string,
): Promise<DuplicateCheckResult> {
  // Check by content hash first (strongest signal)
  const { data: hashMatch } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .eq("metadata->>content_hash", contentHash)
    .limit(1)
    .single();

  if (hashMatch) {
    return { found: true, matchType: "content", existingDocument: hashMatch as Document };
  }

  // Check by original filename
  const { data: nameMatch } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .eq("metadata->>original_filename", filename)
    .limit(1)
    .single();

  if (nameMatch) {
    return { found: true, matchType: "filename", existingDocument: nameMatch as Document };
  }

  return { found: false, matchType: null, existingDocument: null };
}

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Upload file to Supabase Storage and create document record.
 * Full pipeline: extract text → classify → upload → insert.
 */
export async function createDocument(
  supabase: SupabaseClient,
  input: DocumentCreateInput,
): Promise<Document> {
  // 1. Extract text
  let extractedText = "";
  let extractionFailed = false;
  try {
    extractedText = await extractText(input.buffer, input.fileType);
    if (!extractedText || extractedText.length === 0) {
      extractionFailed = true;
    }
  } catch (e) {
    console.error("Text extraction failed:", e);
    extractionFailed = true;
  }

  // 2. Classify
  const categories = await getCategories(supabase);
  let classification: ClassificationResult | null = null;

  if (extractedText.length > 0) {
    classification = await classifyDocument(supabase, extractedText, categories);
  }

  // 3. Upload to Storage
  const timestamp = Date.now();
  const ext = input.filePath.split(".").pop() || "bin";
  const storagePath = `${input.userId}/${timestamp}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, input.buffer, {
      contentType: input.fileType,
      upsert: false,
    });

  if (uploadError) {
    console.error("Storage upload error:", uploadError);
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  // 4. Insert document record
  // Use suggested_title when input title is missing or generic (e.g. Adobe Scan default)
  const genericTitles = ["créé et partagé avec adobe scan.", "créé et partagé avec adobe scan", "shared with adobe scan"];
  const inputTitleIsGeneric = !input.title || genericTitles.includes(input.title.toLowerCase().trim());
  const title = (inputTitleIsGeneric ? classification?.suggested_title : input.title)
    || input.title || classification?.description || input.filePath.split("/").pop() || "Sans titre";

  const record = {
    user_id: input.userId,
    project_id: input.projectId || null,
    category_id: classification?.category_id || null,
    title,
    extracted_text: extractedText || null,
    description: classification?.description || null,
    document_date: classification?.document_date || null,
    file_path: storagePath,
    file_type: input.fileType,
    file_size: input.fileSize || input.buffer.length,
    metadata: {
      original_filename: input.filePath.split("/").pop(),
      content_hash: computeFileHash(input.buffer),
      classification_confidence: classification?.confidence || null,
      is_new_category: classification?.is_new_category || false,
      extraction_failed: extractionFailed,
    },
  };

  const { data, error } = await supabase
    .from("documents")
    .insert(record)
    .select("*")
    .single();

  if (error) {
    // Cleanup uploaded file on insert failure
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    console.error("Document insert error:", error);
    throw new Error(`Insert failed: ${error.message}`);
  }

  return data as Document;
}

/**
 * List documents for a user with optional filters.
 */
export async function listDocuments(
  supabase: SupabaseClient,
  userId: string,
  options: ListDocumentsOptions = {},
): Promise<Document[]> {
  const { categoryId, limit = 20, offset = 0 } = options;

  let query = supabase
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (categoryId) {
    query = query.eq("category_id", categoryId);
  }

  const { data, error } = await query;

  if (error) {
    console.error("listDocuments error:", error);
    return [];
  }
  return data || [];
}

/**
 * Get a single document by ID.
 */
export async function getDocumentById(
  supabase: SupabaseClient,
  id: string,
): Promise<Document | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("getDocumentById error:", error);
    return null;
  }
  return data as Document;
}

/**
 * Delete a document: remove from DB and cleanup Storage.
 */
export async function deleteDocument(
  supabase: SupabaseClient,
  id: string,
): Promise<boolean> {
  // Get file_path first for storage cleanup
  const doc = await getDocumentById(supabase, id);
  if (!doc) return false;

  // Delete from DB
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("deleteDocument error:", error);
    return false;
  }

  // Cleanup storage
  if (doc.file_path) {
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([doc.file_path]);

    if (storageError) {
      console.error("Storage cleanup error:", storageError);
      // DB record already deleted, log but don't fail
    }
  }

  return true;
}

// ── Search ───────────────────────────────────────────────────

/**
 * Semantic search on documents via Edge Function.
 * Uses match_documents RPC through the search Edge Function.
 */
export async function searchDocuments(
  supabase: SupabaseClient,
  query: string,
  userId?: string,
  options: { matchCount?: number; matchThreshold?: number } = {},
): Promise<DocumentSearchResult[]> {
  const { matchCount = 10, matchThreshold = 0.3 } = options;

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query,
        table: "documents",
        match_count: matchCount,
        match_threshold: matchThreshold,
        user_id: userId,
      },
    });

    if (error) {
      console.error("searchDocuments error:", error);
      return [];
    }

    return (data || []) as DocumentSearchResult[];
  } catch (e) {
    console.error("searchDocuments exception:", e);
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Get document count stats per category for a user.
 */
export async function getDocumentStats(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ total: number; byCategory: Array<{ name: string; count: number }> }> {
  const { data: docs, error } = await supabase
    .from("documents")
    .select("category_id")
    .eq("user_id", userId);

  if (error || !docs) {
    return { total: 0, byCategory: [] };
  }

  const categories = await getCategories(supabase);
  const catMap = new Map(categories.map((c) => [c.id, c.name]));

  const counts = new Map<string, number>();
  for (const doc of docs) {
    const name = catMap.get(doc.category_id) || "non classifie";
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const byCategory = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { total: docs.length, byCategory };
}

/**
 * Generate signed download URLs for a list of file paths.
 * Returns a map from file_path to signed URL. Expired after 1 hour.
 */
export async function createSignedUrls(
  supabase: SupabaseClient,
  filePaths: string[],
  expiresIn = 3600,
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  if (filePaths.length === 0) return urlMap;

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(filePaths, expiresIn);

    if (error) {
      console.error("createSignedUrls error:", error);
      return urlMap;
    }

    for (const item of data || []) {
      if (item.signedUrl && item.path) {
        urlMap.set(item.path, item.signedUrl);
      }
    }
  } catch (e) {
    console.error("createSignedUrls exception:", e);
  }
  return urlMap;
}
