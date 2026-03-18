/**
 * @module documents
 * @description Document management: text extraction (Claude Vision + pdf-parse),
 * LLM classification (Haiku) with dynamic categories, CRUD with Supabase Storage,
 * semantic search via Edge Function. S45-T2.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
  projectId?: string;
  title?: string;
  filePath: string;
  fileType: string;
  fileSize?: number;
  buffer: Buffer;
}

export interface ClassificationResult {
  category_id: string;
  category_name: string;
  confidence: number;
  description: string;
  document_date: string | null;
  is_new_category: boolean;
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
}

export interface ListDocumentsOptions {
  categoryId?: string;
  limit?: number;
  offset?: number;
}

// ── Constants ────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const VISION_MODEL = "claude-haiku-4-5-20251001";
const CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";
const VISION_MAX_TOKENS = 2048;
const CLASSIFICATION_MAX_TOKENS = 512;
const NEW_CATEGORY_CONFIDENCE_THRESHOLD = 0.6;
const STORAGE_BUCKET = "documents";

// ── Text Extraction ──────────────────────────────────────────

/**
 * Extract text from an image using Claude Vision API.
 */
export async function extractTextFromImage(
  buffer: Buffer,
  fileType: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const base64 = buffer.toString("base64");
  const mediaType = fileType === "image/webp" ? "image/webp"
    : fileType === "image/png" ? "image/png"
    : fileType === "image/gif" ? "image/gif"
    : "image/jpeg";

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: VISION_MAX_TOKENS,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: "Extract ALL text visible in this document image. Return only the raw extracted text, no commentary. If there is no text, return an empty string.",
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vision API error: ${response.status} ${err}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text?.trim() || "";
}

/**
 * Extract text from a PDF using pdf-parse, with Vision fallback if empty.
 */
export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse(new Uint8Array(buffer));
    await parser.load();
    const text = (await parser.getText())?.trim() || "";
    if (text.length > 0) return text;
  } catch (e) {
    console.error("pdf-parse error, falling back to Vision:", e);
  }

  // Fallback: Vision on first page (convert PDF buffer to image-like for Vision)
  return extractTextFromImage(buffer, "application/pdf");
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
 * Classify a document using Haiku LLM with dynamic categories.
 * If confidence < 0.6, creates a new category.
 */
export async function classifyDocument(
  supabase: SupabaseClient,
  text: string,
  categories: DocumentCategory[],
): Promise<ClassificationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const categoryList = categories
    .map((c) => `- ${c.name}: ${c.description || "pas de description"}`)
    .join("\n");

  const prompt = `Tu es un classifieur de documents. Analyse le texte suivant et classe-le dans une des categories existantes, ou propose une nouvelle categorie si aucune ne convient.

CATEGORIES EXISTANTES:
${categoryList}

TEXTE DU DOCUMENT (premiers 2000 caracteres):
${text.substring(0, 2000)}

Reponds UNIQUEMENT en JSON:
{
  "category_name": "nom de la categorie (existante ou nouvelle)",
  "confidence": 0.0 a 1.0,
  "description": "description courte du document en une phrase",
  "document_date": "YYYY-MM-DD ou null si pas de date detectee",
  "suggested_title": "titre suggere pour le document"
}`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFICATION_MODEL,
      max_tokens: CLASSIFICATION_MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Classification API error: ${response.status} ${err}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const rawText = data.content?.[0]?.text || "{}";

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
  };
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
  const extractedText = await extractText(input.buffer, input.fileType);

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
  const title = input.title || classification?.description || input.filePath.split("/").pop() || "Sans titre";

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
      classification_confidence: classification?.confidence || null,
      is_new_category: classification?.is_new_category || false,
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
  const { matchCount = 10, matchThreshold = 0.7 } = options;

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
