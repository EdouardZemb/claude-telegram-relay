-- ============================================================
-- Migration: Schema synchronization DB/code/schema.sql
-- Date: 2026-03-20
-- Spec: docs/specs/SPEC-migration-schema-supabase.md
-- ============================================================
-- IMPORTANT: Apply this migration BEFORE deploying code changes.
-- This migration is idempotent (safe to replay).
-- ============================================================

-- ============================================================
-- 1. Create missing tables (R1, R7)
-- ============================================================

-- 1a. pipeline_runs
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  session_id TEXT NOT NULL UNIQUE,
  task_id UUID REFERENCES tasks(id),
  pipeline_type TEXT NOT NULL,
  pipeline_agents TEXT[] NOT NULL DEFAULT '{}',
  current_step INTEGER NOT NULL DEFAULT 0,
  steps_completed JSONB NOT NULL DEFAULT '[]',
  steps_results JSONB NOT NULL DEFAULT '[]',
  blackboard_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'paused')),
  error TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_session ON pipeline_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task ON pipeline_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

-- 1b. gate_evaluations
CREATE TABLE IF NOT EXISTS gate_evaluations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  session_id TEXT NOT NULL,
  task_id UUID REFERENCES tasks(id),
  sprint_id TEXT,
  agent_role TEXT NOT NULL,
  gate_name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  passed BOOLEAN NOT NULL DEFAULT FALSE,
  rubric_dimensions JSONB,
  deterministic_checks JSONB,
  rework_iteration INTEGER NOT NULL DEFAULT 0,
  rework_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  auto_approved BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_gate_evaluations_agent_role ON gate_evaluations(agent_role);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_gate_name ON gate_evaluations(gate_name);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_session ON gate_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_created ON gate_evaluations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_sprint ON gate_evaluations(sprint_id);

-- 1c. trust_scores
CREATE TABLE IF NOT EXISTS trust_scores (
  agent_role TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 50,
  consecutive_passes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_evaluations INTEGER NOT NULL DEFAULT 0,
  total_passes INTEGER NOT NULL DEFAULT 0,
  last_evaluation_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1d. agent_events
CREATE TABLE IF NOT EXISTS agent_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_role ON agent_events(session_id, agent_role);

-- ============================================================
-- 2. Add missing column to cost_tracking (R2, R7)
-- ============================================================
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS model TEXT;

-- ============================================================
-- 3. Add missing column to workflow_logs (discovered during implementation)
-- Schema.sql declares metadata JSONB but it's missing from production.
-- Without this column, the corrected inserts from code-review.ts and
-- orchestrator.ts cannot store metadata (type info, scores, etc.)
-- ============================================================
ALTER TABLE workflow_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ============================================================
-- 4. Trigger for pipeline_runs updated_at (R1, R11)
-- ============================================================
CREATE OR REPLACE FUNCTION update_pipeline_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS pipeline_runs_updated_at ON pipeline_runs;
CREATE TRIGGER pipeline_runs_updated_at
  BEFORE UPDATE ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION update_pipeline_runs_updated_at();

-- ============================================================
-- 5. RLS enable + policies (R8, R11)
-- ============================================================

-- pipeline_runs
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated" ON pipeline_runs;
CREATE POLICY "Allow all for authenticated" ON pipeline_runs FOR ALL USING (true);

-- gate_evaluations (RLS already in schema.sql, ensure it exists in prod)
ALTER TABLE gate_evaluations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated" ON gate_evaluations;
CREATE POLICY "Allow all for authenticated" ON gate_evaluations FOR ALL USING (true);

-- trust_scores (RLS already in schema.sql, ensure it exists in prod)
ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated" ON trust_scores;
CREATE POLICY "Allow all for authenticated" ON trust_scores FOR ALL USING (true);

-- agent_events
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated" ON agent_events;
CREATE POLICY "Allow all for authenticated" ON agent_events FOR ALL USING (true);

-- audit_results (exists in prod but no RLS, align with project pattern)
ALTER TABLE audit_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for authenticated" ON audit_results;
CREATE POLICY "Allow all for authenticated" ON audit_results FOR ALL USING (true);

-- ============================================================
-- Deployment order reminder:
-- 1. Apply this migration SQL
-- 2. Then deploy TypeScript code changes (pm2 restart)
-- ============================================================
