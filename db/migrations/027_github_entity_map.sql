-- GitHub entity map: tracks mapping between pipeline runs/phases and GitHub issues
-- Used by github-sync module for idempotent push operations and crash recovery

CREATE TABLE IF NOT EXISTS github_entity_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,
  pipeline_type TEXT NOT NULL CHECK (pipeline_type IN ('maturation', 'v3')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('run_issue', 'phase_issue')),
  phase TEXT,
  issue_number INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  project_item_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_entity_run_phase
  ON github_entity_map(run_id, entity_type, COALESCE(phase, ''));

COMMENT ON TABLE github_entity_map IS 'Maps pipeline runs/phases to GitHub issues for unidirectional sync';
