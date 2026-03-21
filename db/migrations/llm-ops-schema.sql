-- ============================================================
-- LLM-Ops Schema Migration
-- ============================================================
-- Adds:
-- 1. prompt_versions table (R3: prompt versioning)
-- 2. span_id + session_id columns on cost_tracking (R4: span attribution)
-- Non-destructive: uses IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.
-- ============================================================

-- ── Table: prompt_versions ──────────────────────────────────

CREATE TABLE IF NOT EXISTS prompt_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_role TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  feedback_hash TEXT NOT NULL,
  combined_hash TEXT NOT NULL,
  UNIQUE (agent_role, combined_hash)
);

COMMENT ON TABLE prompt_versions IS 'Tracks prompt template + feedback rule versions per agent role for drift detection';

-- ── Columns: cost_tracking span attribution ─────────────────

ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS span_id TEXT;
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS session_id TEXT;

-- Index on session_id for cost aggregation queries
CREATE INDEX IF NOT EXISTS idx_cost_tracking_session ON cost_tracking(session_id);
