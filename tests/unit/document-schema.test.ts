/**
 * Unit Tests — S45-T1: Document schema validation
 *
 * Validates that db/schema.sql contains the document_categories
 * and documents tables with correct structure, indexes, RLS,
 * base categories, and match_documents RPC.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SCHEMA_PATH = join(import.meta.dir, "../../db/schema.sql");
const schema = readFileSync(SCHEMA_PATH, "utf-8");

// ── document_categories table ────────────────────────────────

describe("document_categories table", () => {
  it("creates the table with correct columns", () => {
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS document_categories");
    expect(schema).toContain("name TEXT UNIQUE NOT NULL");
    expect(schema).toContain("usage_count INTEGER DEFAULT 0");
    expect(schema).toContain("created_by TEXT DEFAULT 'system'");
  });

  it("has a UUID primary key", () => {
    // Match the PK definition within the document_categories block
    const tableBlock = schema
      .split("CREATE TABLE IF NOT EXISTS document_categories")[1]
      ?.split(");")[0];
    expect(tableBlock).toContain("id UUID DEFAULT gen_random_uuid() PRIMARY KEY");
  });

  it("seeds 7 base categories", () => {
    const baseCategories = [
      "facture",
      "contrat",
      "recu",
      "note",
      "identite",
      "attestation",
      "courrier",
    ];
    for (const cat of baseCategories) {
      expect(schema).toContain(`('${cat}',`);
    }
  });

  it("uses ON CONFLICT DO NOTHING for idempotent seeding", () => {
    expect(schema).toContain("ON CONFLICT (name) DO NOTHING");
  });

  it("has RLS enabled", () => {
    expect(schema).toContain("ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY");
  });

  it("has RLS policy for full access", () => {
    expect(schema).toContain(
      'CREATE POLICY "Allow all for authenticated" ON document_categories FOR ALL USING (true)',
    );
  });
});

// ── documents table ──────────────────────────────────────────

describe("documents table", () => {
  it("creates the table with all required columns", () => {
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS documents");
    const tableBlock = schema.split("CREATE TABLE IF NOT EXISTS documents")[1]?.split(");")[0];
    expect(tableBlock).toBeDefined();

    expect(tableBlock).toContain("user_id TEXT NOT NULL");
    expect(tableBlock).toContain("project_id UUID REFERENCES projects(id)");
    expect(tableBlock).toContain("category_id UUID REFERENCES document_categories(id)");
    expect(tableBlock).toContain("title TEXT");
    expect(tableBlock).toContain("extracted_text TEXT");
    expect(tableBlock).toContain("description TEXT");
    expect(tableBlock).toContain("document_date DATE");
    expect(tableBlock).toContain("file_path TEXT NOT NULL");
    expect(tableBlock).toContain("file_type TEXT NOT NULL");
    expect(tableBlock).toContain("file_size INTEGER");
    expect(tableBlock).toContain("metadata JSONB");
    expect(tableBlock).toContain("embedding VECTOR(1536)");
  });

  it("has FK to document_categories", () => {
    const tableBlock = schema.split("CREATE TABLE IF NOT EXISTS documents")[1]?.split(");")[0];
    expect(tableBlock).toContain("category_id UUID REFERENCES document_categories(id)");
  });

  it("has FK to projects", () => {
    const tableBlock = schema.split("CREATE TABLE IF NOT EXISTS documents")[1]?.split(");")[0];
    expect(tableBlock).toContain("project_id UUID REFERENCES projects(id)");
  });

  it("has indexes for user, category, date, project, created_at", () => {
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id)");
    expect(schema).toContain(
      "CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category_id)",
    );
    expect(schema).toContain(
      "CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(document_date DESC)",
    );
    expect(schema).toContain(
      "CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id)",
    );
    expect(schema).toContain(
      "CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC)",
    );
  });

  it("has IVFFlat embedding index with cosine ops", () => {
    expect(schema).toContain("idx_documents_embedding");
    expect(schema).toContain("USING ivfflat (embedding vector_cosine_ops)");
    expect(schema).toContain("WITH (lists = 100)");
  });

  it("has RLS enabled", () => {
    expect(schema).toContain("ALTER TABLE documents ENABLE ROW LEVEL SECURITY");
  });

  it("has project-scoped RLS policies", () => {
    expect(schema).toContain(
      'CREATE POLICY "documents_insert" ON documents FOR INSERT WITH CHECK (true)',
    );
    expect(schema).toContain('CREATE POLICY "documents_select_by_project" ON documents FOR SELECT');
    expect(schema).toContain(
      'CREATE POLICY "documents_update" ON documents FOR UPDATE USING (true)',
    );
    expect(schema).toContain(
      'CREATE POLICY "documents_delete" ON documents FOR DELETE USING (true)',
    );
  });
});

// ── match_documents RPC ──────────────────────────────────────

describe("match_documents RPC", () => {
  it("defines the function", () => {
    expect(schema).toContain("CREATE OR REPLACE FUNCTION match_documents");
  });

  it("accepts query_embedding, threshold, count, user_id params", () => {
    expect(schema).toContain("query_embedding VECTOR(1536)");
    // Check within match_documents context
    const funcBlock = schema
      .split("CREATE OR REPLACE FUNCTION match_documents")[1]
      ?.split("$$ LANGUAGE plpgsql")[0];
    expect(funcBlock).toContain("match_threshold FLOAT DEFAULT 0.7");
    expect(funcBlock).toContain("match_count INT DEFAULT 10");
    expect(funcBlock).toContain("p_user_id TEXT DEFAULT NULL");
  });

  it("returns document fields with similarity score", () => {
    const funcBlock = schema
      .split("CREATE OR REPLACE FUNCTION match_documents")[1]
      ?.split("$$ LANGUAGE plpgsql")[0];
    expect(funcBlock).toContain("similarity FLOAT");
    expect(funcBlock).toContain("d.title");
    expect(funcBlock).toContain("d.extracted_text");
    expect(funcBlock).toContain("d.document_date");
    expect(funcBlock).toContain("d.category_id");
  });

  it("filters by user_id when provided", () => {
    const funcBlock = schema
      .split("CREATE OR REPLACE FUNCTION match_documents")[1]
      ?.split("$$ LANGUAGE plpgsql")[0];
    expect(funcBlock).toContain("p_user_id IS NULL OR d.user_id = p_user_id");
  });

  it("uses cosine distance for similarity", () => {
    const funcBlock = schema
      .split("CREATE OR REPLACE FUNCTION match_documents")[1]
      ?.split("$$ LANGUAGE plpgsql")[0];
    expect(funcBlock).toContain("1 - (d.embedding <=> query_embedding)");
  });
});

// ── Schema header ────────────────────────────────────────────

describe("schema metadata", () => {
  it("header reflects updated table count", () => {
    expect(schema).toContain("Reflects all 25 public tables");
  });
});
