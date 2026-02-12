-- ============================================================
-- Supabase Schema for Claude Telegram Relay
-- ============================================================
-- Authoritative database schema. Reflects all 12 public tables,
-- indexes, RLS policies, helper functions, and semantic search.
--
-- To set up from scratch: run this in Supabase SQL Editor.
-- Then deploy Edge Functions (embed, search) and webhooks.
-- ============================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- PROJECTS TABLE (Multi-project management)
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  repo_url TEXT,
  directory TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  telegram_topic_id INTEGER,
  current_sprint TEXT,
  workflow_config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}'
);

COMMENT ON TABLE projects IS 'Multi-project management. Each project has its own backlog, sprints, workflow, and BMad config.';

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  project_id UUID REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_project_id ON messages(project_id);

-- ============================================================
-- MEMORY TABLE (Facts & Goals)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);

-- ============================================================
-- LOGS TABLE (Observability)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  session_id TEXT,
  duration_ms INTEGER,
  project_id UUID REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- ============================================================
-- TASKS TABLE (Backlog & Sprint Management)
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  title TEXT NOT NULL,
  description TEXT,
  project TEXT NOT NULL DEFAULT 'telegram-relay',
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'in_progress', 'review', 'done', 'cancelled')),
  priority INTEGER DEFAULT 3 CHECK (priority >= 1 AND priority <= 5),
  sprint TEXT,
  tags TEXT[] DEFAULT '{}',
  estimated_hours NUMERIC,
  actual_hours NUMERIC,
  blocked_by UUID REFERENCES tasks(id),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  -- BMad workflow columns
  acceptance_criteria TEXT,
  dev_notes TEXT,
  architecture_ref TEXT,
  subtasks JSONB DEFAULT '[]',
  project_id UUID REFERENCES projects(id)
);

COMMENT ON COLUMN tasks.acceptance_criteria IS 'BMad: Given/When/Then acceptance criteria';
COMMENT ON COLUMN tasks.dev_notes IS 'BMad: Technical notes for the dev agent';
COMMENT ON COLUMN tasks.architecture_ref IS 'BMad: Reference to architecture document/section';
COMMENT ON COLUMN tasks.subtasks IS 'BMad: Array of {title, ac_mapping, done} subtask objects';

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status_sprint ON tasks(status, sprint);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);

-- Auto-update updated_at on tasks
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_tasks_updated_at();

-- ============================================================
-- PRDS TABLE (Product Requirements Documents)
-- ============================================================
CREATE TABLE IF NOT EXISTS prds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  title TEXT NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT 'telegram-relay',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  tags TEXT[] DEFAULT '{}',
  requested_by TEXT,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  project_id UUID REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_prds_status ON prds(status);
CREATE INDEX IF NOT EXISTS idx_prds_project ON prds(project);
CREATE INDEX IF NOT EXISTS idx_prds_project_id ON prds(project_id);
CREATE INDEX IF NOT EXISTS idx_prds_project_status ON prds(project, status);

-- Auto-update updated_at on prds
CREATE OR REPLACE FUNCTION update_prds_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER prds_updated_at
  BEFORE UPDATE ON prds
  FOR EACH ROW EXECUTE FUNCTION update_prds_updated_at();

-- ============================================================
-- WORKFLOW LOGS TABLE (Workflow transitions & code reviews)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID REFERENCES tasks(id),
  sprint_id TEXT,
  step_from TEXT NOT NULL,
  step_to TEXT NOT NULL,
  duration_seconds INTEGER,
  had_rework BOOLEAN DEFAULT FALSE,
  checkpoint_mode TEXT DEFAULT 'off'
    CHECK (checkpoint_mode IN ('off', 'light', 'strict')),
  checkpoint_result TEXT
    CHECK (checkpoint_result IN ('pass', 'fail', 'skipped', 'corrected')),
  checkpoint_notes TEXT,
  agent_notes TEXT,
  metadata JSONB DEFAULT '{}',
  project_id UUID REFERENCES projects(id)
);

COMMENT ON TABLE workflow_logs IS 'Trace chaque transition d''etape du workflow pour mesurabilite';

CREATE INDEX IF NOT EXISTS idx_workflow_logs_task ON workflow_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_sprint ON workflow_logs(sprint_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_created ON workflow_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_project_id ON workflow_logs(project_id);

-- ============================================================
-- SPRINT METRICS TABLE (Velocity & performance tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS sprint_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sprint_id TEXT NOT NULL UNIQUE,
  tasks_planned INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  completion_rate NUMERIC GENERATED ALWAYS AS (
    CASE WHEN tasks_planned > 0
      THEN (tasks_completed::NUMERIC / tasks_planned::NUMERIC) * 100
      ELSE 0
    END
  ) STORED,
  avg_delivery_hours NUMERIC,
  first_pass_rate NUMERIC,
  incidents_count INTEGER NOT NULL DEFAULT 0,
  rework_count INTEGER NOT NULL DEFAULT 0,
  retro_actions_proposed INTEGER NOT NULL DEFAULT 0,
  retro_actions_accepted INTEGER NOT NULL DEFAULT 0,
  sprint_started_at TIMESTAMPTZ,
  sprint_ended_at TIMESTAMPTZ,
  project_id UUID REFERENCES projects(id)
);

COMMENT ON TABLE sprint_metrics IS 'Metriques automatiques par sprint pour amelioration continue';

CREATE INDEX IF NOT EXISTS idx_sprint_metrics_project_id ON sprint_metrics(project_id);

-- ============================================================
-- RETROS TABLE (Sprint retrospectives)
-- ============================================================
CREATE TABLE IF NOT EXISTS retros (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sprint_id TEXT NOT NULL UNIQUE,
  what_worked TEXT[] DEFAULT '{}',
  what_didnt TEXT[] DEFAULT '{}',
  patterns_detected TEXT[] DEFAULT '{}',
  actions_proposed JSONB DEFAULT '[]',
  actions_accepted JSONB DEFAULT '[]',
  raw_analysis TEXT,
  validated_at TIMESTAMPTZ,
  project_id UUID REFERENCES projects(id)
);

COMMENT ON TABLE retros IS 'Retrospectives de sprint avec analyse et actions proposees/validees';

CREATE INDEX IF NOT EXISTS idx_retros_project_id ON retros(project_id);

-- ============================================================
-- FEEDBACK RULES TABLE (Learning from retros)
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  agent_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  instruction TEXT NOT NULL,
  occurrences INTEGER DEFAULT 1,
  sprints TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_feedback_rules_agent_active ON feedback_rules(agent_id, active);

-- ============================================================
-- DOCUMENT SHARDS TABLE (Intelligent context caching)
-- ============================================================
CREATE TABLE IF NOT EXISTS document_shards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  document_id UUID NOT NULL,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('prd', 'architecture', 'story', 'research')),
  section_title TEXT NOT NULL,
  section_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  refs TEXT[] DEFAULT '{}',
  project_id UUID REFERENCES projects(id),
  UNIQUE(document_id, section_index)
);

COMMENT ON TABLE document_shards IS 'Stores indexed sections of large documents (PRDs, architecture) for efficient context loading';

CREATE INDEX IF NOT EXISTS idx_document_shards_document_id ON document_shards(document_id);
CREATE INDEX IF NOT EXISTS idx_document_shards_type ON document_shards(document_type);
CREATE INDEX IF NOT EXISTS idx_document_shards_project_id ON document_shards(project_id);

-- ============================================================
-- WORKFLOW PROPOSALS TABLE (Cross-project improvements)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_proposals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  proposal_type TEXT NOT NULL
    CHECK (proposal_type IN ('gate_change', 'checkpoint_change', 'workflow_adjustment')),
  target TEXT NOT NULL,
  description TEXT NOT NULL,
  suggested_value TEXT NOT NULL,
  source_project_id UUID REFERENCES projects(id),
  source_sprint TEXT NOT NULL,
  votes TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'promoted', 'rejected')),
  promoted_at TIMESTAMPTZ,
  UNIQUE(proposal_type, target, suggested_value, status)
);

COMMENT ON TABLE workflow_proposals IS 'Cross-project workflow improvement proposals with voting mechanism';

CREATE INDEX IF NOT EXISTS idx_workflow_proposals_status ON workflow_proposals(status);
CREATE INDEX IF NOT EXISTS idx_workflow_proposals_target ON workflow_proposals(target);

-- ============================================================
-- WORKFLOW AUDIT TABLE (Configuration change tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_audit (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  author TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  reason TEXT,
  changes JSONB NOT NULL DEFAULT '[]',
  config_version INTEGER,
  config_snapshot JSONB
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE prds ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE retros ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_shards ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_audit ENABLE ROW LEVEL SECURITY;

-- Project-scoped RLS helper function
CREATE OR REPLACE FUNCTION current_project_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_project_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = '';

CREATE OR REPLACE FUNCTION set_project_scope(p_id UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_project_id', p_id::TEXT, false);
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Projects: full access
CREATE POLICY "Allow all for authenticated" ON projects FOR ALL USING (true);

-- Messages: project-scoped reads, open writes
CREATE POLICY "messages_insert" ON messages FOR INSERT WITH CHECK (true);
CREATE POLICY "messages_select_by_project" ON messages FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "messages_update" ON messages FOR UPDATE USING (true);

-- Memory: full access
CREATE POLICY "Allow all for service role" ON memory FOR ALL USING (true);

-- Logs: project-scoped reads, open writes
CREATE POLICY "logs_insert" ON logs FOR INSERT WITH CHECK (true);
CREATE POLICY "logs_select_by_project" ON logs FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());

-- Tasks: project-scoped reads, open writes/updates/deletes
CREATE POLICY "tasks_insert" ON tasks FOR INSERT WITH CHECK (true);
CREATE POLICY "tasks_select_by_project" ON tasks FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "tasks_update" ON tasks FOR UPDATE USING (true);
CREATE POLICY "tasks_delete" ON tasks FOR DELETE USING (true);

-- PRDs: project-scoped reads, open writes/updates/deletes
CREATE POLICY "prds_insert" ON prds FOR INSERT WITH CHECK (true);
CREATE POLICY "prds_select_by_project" ON prds FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "prds_update" ON prds FOR UPDATE USING (true);
CREATE POLICY "prds_delete" ON prds FOR DELETE USING (true);

-- Workflow logs: project-scoped reads, open writes
CREATE POLICY "wf_logs_insert" ON workflow_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "wf_logs_select_by_project" ON workflow_logs FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());

-- Sprint metrics: project-scoped reads, open writes/updates
CREATE POLICY "metrics_insert" ON sprint_metrics FOR INSERT WITH CHECK (true);
CREATE POLICY "metrics_select_by_project" ON sprint_metrics FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "metrics_update" ON sprint_metrics FOR UPDATE USING (true);

-- Retros: project-scoped reads, open writes/updates
CREATE POLICY "retros_insert" ON retros FOR INSERT WITH CHECK (true);
CREATE POLICY "retros_select_by_project" ON retros FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "retros_update" ON retros FOR UPDATE USING (true);

-- Feedback rules: full access
CREATE POLICY "Allow all for authenticated" ON feedback_rules FOR ALL USING (true);

-- Document shards: project-scoped reads, open writes/deletes
CREATE POLICY "shards_insert" ON document_shards FOR INSERT WITH CHECK (true);
CREATE POLICY "shards_select_by_project" ON document_shards FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "shards_update" ON document_shards FOR UPDATE USING (true);
CREATE POLICY "shards_delete" ON document_shards FOR DELETE USING (true);

-- Workflow proposals: full access
CREATE POLICY "Allow all for authenticated" ON workflow_proposals FOR ALL USING (true);

-- Workflow audit: full access
CREATE POLICY "Allow all for authenticated" ON workflow_audit FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS (RPCs)
-- ============================================================

-- Get recent messages for context
CREATE OR REPLACE FUNCTION get_recent_messages(limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM public.messages m
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Get active goals
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM public.memory m
  WHERE m.type = 'goal'
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Get all facts
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM public.memory m
  WHERE m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Sprint summary: count tasks by status for a given sprint
CREATE OR REPLACE FUNCTION get_sprint_summary(p_sprint TEXT)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'total', COUNT(*),
    'backlog', COUNT(*) FILTER (WHERE t.status = 'backlog'),
    'in_progress', COUNT(*) FILTER (WHERE t.status = 'in_progress'),
    'review', COUNT(*) FILTER (WHERE t.status = 'review'),
    'done', COUNT(*) FILTER (WHERE t.status = 'done')
  ) INTO result
  FROM public.tasks t
  WHERE t.sprint = p_sprint AND t.status != 'cancelled';
  RETURN result;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- ============================================================
-- SEMANTIC SEARCH
-- ============================================================
-- Embeddings are generated automatically by the embed Edge Function
-- via database webhook. The search Edge Function calls these RPCs.

-- Match messages by embedding similarity
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Match memory entries by embedding similarity
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM public.memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SET search_path = '';
