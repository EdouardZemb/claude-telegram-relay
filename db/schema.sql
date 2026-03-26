-- ============================================================
-- Supabase Schema for Claude Telegram Relay
-- ============================================================
-- Authoritative database schema. Reflects all 25 public tables,
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
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'idea')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  importance_score NUMERIC DEFAULT 50,
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_count INTEGER DEFAULT 0,
  idea_status TEXT CHECK (idea_status IS NULL OR idea_status IN ('new', 'reviewed', 'promoted', 'archived')),
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

COMMENT ON COLUMN memory.importance_score IS 'Importance score 0-100, decays over time, boosted by access';
COMMENT ON COLUMN memory.last_accessed_at IS 'Last time this memory was accessed/used in context';
COMMENT ON COLUMN memory.access_count IS 'Number of times this memory was accessed/used';

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_idea_status ON memory(idea_status) WHERE idea_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memory_last_accessed ON memory(last_accessed_at DESC);

COMMENT ON COLUMN memory.idea_status IS 'Lifecycle status for idea-type memories: new → reviewed → promoted → archived';

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
  project_id UUID REFERENCES projects(id),
  sdd_pipeline_name TEXT
);

COMMENT ON COLUMN tasks.acceptance_criteria IS 'BMad: Given/When/Then acceptance criteria';
COMMENT ON COLUMN tasks.dev_notes IS 'BMad: Technical notes for the dev agent';
COMMENT ON COLUMN tasks.architecture_ref IS 'BMad: Reference to architecture document/section';
COMMENT ON COLUMN tasks.subtasks IS 'BMad: Array of {title, ac_mapping, done} subtask objects';
COMMENT ON COLUMN tasks.sdd_pipeline_name IS 'SDD: pipeline name linking task to SDD pipeline tracker';

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
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd NUMERIC DEFAULT 0,
  agent_executions INTEGER DEFAULT 0,
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
  active BOOLEAN DEFAULT FALSE,
  source TEXT DEFAULT 'retro'
    CHECK (source IN ('retro', 'double_loop'))
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
-- COST TRACKING TABLE (Token usage & budget visibility)
-- ============================================================
CREATE TABLE IF NOT EXISTS cost_tracking (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID REFERENCES tasks(id),
  sprint_id TEXT,
  agent_role TEXT,
  agent_name TEXT,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tokens_total INTEGER GENERATED ALWAYS AS (tokens_input + tokens_output) STORED,
  cost_usd NUMERIC DEFAULT 0,
  model TEXT,
  duration_ms INTEGER DEFAULT 0,
  retry_attempt INTEGER DEFAULT 0,
  context TEXT,
  metadata JSONB DEFAULT '{}',
  project_id UUID REFERENCES projects(id),
  span_id TEXT,
  session_id TEXT
);

COMMENT ON TABLE cost_tracking IS 'Tracks token usage and cost per agent execution for budget visibility';

CREATE INDEX IF NOT EXISTS idx_cost_tracking_task ON cost_tracking(task_id);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_sprint ON cost_tracking(sprint_id);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_created ON cost_tracking(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_project_id ON cost_tracking(project_id);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_session ON cost_tracking(session_id);

-- ============================================================
-- PROMPT VERSIONS TABLE (LLM-Ops prompt drift detection)
-- ============================================================
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

-- ============================================================
-- BLACKBOARD TABLE (Shared structured workspace for pipelines)
-- ============================================================
CREATE TABLE IF NOT EXISTS blackboard (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID REFERENCES tasks(id),
  session_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  sections JSONB NOT NULL DEFAULT '{}',
  history JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed')),
  pipeline_type TEXT,
  project_id UUID REFERENCES projects(id)
);

COMMENT ON TABLE blackboard IS 'Shared structured workspace for multi-agent pipelines. Versioned JSONB sections with optimistic locking.';

CREATE INDEX IF NOT EXISTS idx_blackboard_session ON blackboard(session_id);
CREATE INDEX IF NOT EXISTS idx_blackboard_task ON blackboard(task_id);
CREATE INDEX IF NOT EXISTS idx_blackboard_status ON blackboard(status);

-- Auto-update updated_at on blackboard
CREATE OR REPLACE FUNCTION update_blackboard_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER blackboard_updated_at
  BEFORE UPDATE ON blackboard
  FOR EACH ROW EXECUTE FUNCTION update_blackboard_updated_at();

-- ============================================================
-- PIPELINE RUNS TABLE (Checkpoint / resume for orchestration)
-- ============================================================
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

COMMENT ON TABLE pipeline_runs IS 'Pipeline execution state for checkpoint/resume. Saves progress after each agent step.';

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_session ON pipeline_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task ON pipeline_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

-- Auto-update updated_at on pipeline_runs
CREATE OR REPLACE FUNCTION update_pipeline_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER pipeline_runs_updated_at
  BEFORE UPDATE ON pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION update_pipeline_runs_updated_at();

-- ============================================================
-- GATE EVALUATIONS TABLE (S35: Gate evaluation persistence)
-- ============================================================
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

COMMENT ON TABLE gate_evaluations IS 'Persisted gate evaluation results for trust scoring and double-loop learning (S35).';

CREATE INDEX IF NOT EXISTS idx_gate_evaluations_agent_role ON gate_evaluations(agent_role);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_gate_name ON gate_evaluations(gate_name);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_session ON gate_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_created ON gate_evaluations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_evaluations_sprint ON gate_evaluations(sprint_id);

-- ============================================================
-- TRUST SCORES TABLE (S35: Trust per agent role)
-- ============================================================
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

COMMENT ON TABLE trust_scores IS 'Trust scores per agent role for progressive autonomy (S35).';

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
-- MEMORY LINKS TABLE (Semantic links between memories, S36-01)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  similarity FLOAT NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  link_type TEXT NOT NULL DEFAULT 'related' CHECK (link_type IN ('related', 'extends', 'supports', 'contradicts')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_id, target_id),
  CHECK (source_id != target_id)
);

COMMENT ON TABLE memory_links IS 'Bidirectional semantic links between memories. Each pair (A,B) stored as 2 rows (A→B, B→A) for query simplicity.';

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);

-- link_memory() RPC: finds similar memories and creates bidirectional links
CREATE OR REPLACE FUNCTION link_memory(
  p_memory_id UUID,
  p_threshold FLOAT DEFAULT 0.65,
  p_max_links INT DEFAULT 5
)
RETURNS INTEGER AS $$
DECLARE
  v_embedding VECTOR(1536);
  v_existing_count INT;
  v_match RECORD;
  v_links_created INT := 0;
  v_target_count INT;
  v_link_type TEXT;
BEGIN
  -- Fetch the memory's embedding
  SELECT embedding INTO v_embedding
  FROM public.memory
  WHERE id = p_memory_id;

  IF v_embedding IS NULL THEN
    RETURN 0;
  END IF;

  -- Count existing outgoing links
  SELECT COUNT(*) INTO v_existing_count
  FROM public.memory_links
  WHERE source_id = p_memory_id;

  IF v_existing_count >= p_max_links THEN
    RETURN 0;
  END IF;

  -- Find similar memories (inline vector similarity, no match_memory call)
  FOR v_match IN
    SELECT m.id, 1 - (m.embedding <=> v_embedding) AS sim
    FROM public.memory m
    WHERE m.embedding IS NOT NULL
      AND m.id != p_memory_id
      AND 1 - (m.embedding <=> v_embedding) > p_threshold
    ORDER BY m.embedding <=> v_embedding
    LIMIT p_max_links - v_existing_count
  LOOP
    -- Determine link type based on similarity
    v_link_type := CASE
      WHEN v_match.sim >= 0.75 THEN 'extends'
      ELSE 'related'
    END;

    -- Insert forward link (source → target)
    INSERT INTO public.memory_links (source_id, target_id, similarity, link_type)
    VALUES (p_memory_id, v_match.id, v_match.sim, v_link_type)
    ON CONFLICT (source_id, target_id) DO NOTHING;

    IF FOUND THEN
      v_links_created := v_links_created + 1;
    END IF;

    -- Insert reverse link (target → source) if target not at max
    SELECT COUNT(*) INTO v_target_count
    FROM public.memory_links
    WHERE source_id = v_match.id;

    IF v_target_count < p_max_links THEN
      INSERT INTO public.memory_links (source_id, target_id, similarity, link_type)
      VALUES (v_match.id, p_memory_id, v_match.sim, v_link_type)
      ON CONFLICT (source_id, target_id) DO NOTHING;

      IF FOUND THEN
        v_links_created := v_links_created + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_links_created;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'link_memory error: %', SQLERRM;
  RETURN v_links_created;
END;
$$ LANGUAGE plpgsql SET search_path = 'public';

-- auto_link_memory() trigger: fires when embedding transitions NULL → non-NULL
CREATE OR REPLACE FUNCTION auto_link_memory()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.link_memory(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER memory_auto_link
  AFTER UPDATE OF embedding ON memory
  FOR EACH ROW
  WHEN (OLD.embedding IS NULL AND NEW.embedding IS NOT NULL)
  EXECUTE FUNCTION auto_link_memory();

CREATE TRIGGER memory_auto_link_insert
  AFTER INSERT ON memory
  FOR EACH ROW
  WHEN (NEW.embedding IS NOT NULL)
  EXECUTE FUNCTION auto_link_memory();

-- get_linked_memories() RPC: batch fetch linked memories for a set of memory IDs (S36-02)
CREATE OR REPLACE FUNCTION get_linked_memories(p_memory_ids UUID[])
RETURNS TABLE(
  origin_id UUID,
  linked_id UUID,
  linked_content TEXT,
  linked_type TEXT,
  similarity FLOAT,
  link_type TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ml.source_id AS origin_id,
    ml.target_id AS linked_id,
    m.content AS linked_content,
    m.type AS linked_type,
    ml.similarity,
    ml.link_type
  FROM public.memory_links ml
  JOIN public.memory m ON m.id = ml.target_id
  WHERE ml.source_id = ANY(p_memory_ids)
  ORDER BY ml.similarity DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- ============================================================
-- MEMORY ARCHIVE TABLE (Old memories for retention management)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_archive (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  importance_score NUMERIC DEFAULT 50,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

COMMENT ON TABLE memory_archive IS 'Archived memory entries older than retention threshold. No embeddings to save storage.';

CREATE INDEX IF NOT EXISTS idx_memory_archive_type ON memory_archive(type);
CREATE INDEX IF NOT EXISTS idx_memory_archive_archived_at ON memory_archive(archived_at DESC);

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
ALTER TABLE cost_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE blackboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_archive ENABLE ROW LEVEL SECURITY;

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

-- Cost tracking: full access
CREATE POLICY "Allow all for authenticated" ON cost_tracking FOR ALL USING (true);

-- Blackboard: full access
CREATE POLICY "Allow all for authenticated" ON blackboard FOR ALL USING (true);

-- Memory archive: full access
CREATE POLICY "Allow all for authenticated" ON memory_archive FOR ALL USING (true);

-- Memory links: full access
ALTER TABLE memory_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON memory_links FOR ALL USING (true);

-- Gate evaluations: full access
ALTER TABLE gate_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON gate_evaluations FOR ALL USING (true);

-- Trust scores: full access
ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON trust_scores FOR ALL USING (true);

-- Pipeline runs: full access
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON pipeline_runs FOR ALL USING (true);

-- Agent events: full access
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON agent_events FOR ALL USING (true);

-- Audit results: full access
ALTER TABLE audit_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON audit_results FOR ALL USING (true);

-- Document categories: full access
ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON document_categories FOR ALL USING (true);

-- Documents: project-scoped reads, open writes/updates/deletes
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "documents_insert" ON documents FOR INSERT WITH CHECK (true);
CREATE POLICY "documents_select_by_project" ON documents FOR SELECT
  USING (current_project_id() IS NULL OR project_id = current_project_id());
CREATE POLICY "documents_update" ON documents FOR UPDATE USING (true);
CREATE POLICY "documents_delete" ON documents FOR DELETE USING (true);

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

-- Get active goals (ranked by importance)
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER,
  importance_score NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority, m.importance_score
  FROM public.memory m
  WHERE m.type = 'goal'
  ORDER BY m.importance_score DESC, m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Get all facts (ranked by importance)
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT,
  importance_score NUMERIC,
  access_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.importance_score, m.access_count
  FROM public.memory m
  WHERE m.type = 'fact'
  ORDER BY m.importance_score DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Bump access stats when memories are used in context
CREATE OR REPLACE FUNCTION bump_memory_access(memory_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE public.memory
  SET
    last_accessed_at = NOW(),
    access_count = access_count + 1,
    updated_at = NOW()
  WHERE id = ANY(memory_ids);
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
$$ LANGUAGE plpgsql SET search_path = 'public';

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
$$ LANGUAGE plpgsql SET search_path = 'public';

-- Match documents by embedding similarity (S45)
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  p_user_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  extracted_text TEXT,
  description TEXT,
  document_date DATE,
  category_id UUID,
  created_at TIMESTAMPTZ,
  similarity FLOAT,
  file_path TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.title,
    d.extracted_text,
    d.description,
    d.document_date,
    d.category_id,
    d.created_at,
    1 - (d.embedding <=> query_embedding) AS similarity,
    d.file_path
  FROM public.documents d
  WHERE d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
    AND (p_user_id IS NULL OR d.user_id = p_user_id)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SET search_path = 'public';

-- ============================================================
-- MEMORY ARCHIVE RPC
-- ============================================================
-- Archive old completed goals and stale facts.
-- Moves rows from memory to memory_archive (without embeddings).
CREATE OR REPLACE FUNCTION archive_old_memories(days_threshold INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  WITH moved AS (
    DELETE FROM public.memory
    WHERE (
      (type = 'completed_goal' AND completed_at < NOW() - (days_threshold || ' days')::INTERVAL)
      OR
      (type = 'fact' AND updated_at < NOW() - (days_threshold || ' days')::INTERVAL)
    )
    RETURNING id, created_at, type, content, deadline, completed_at, priority, metadata, importance_score, last_accessed_at, access_count
  )
  INSERT INTO public.memory_archive (id, created_at, type, content, deadline, completed_at, priority, metadata, importance_score, last_accessed_at, access_count)
  SELECT id, created_at, type, content, deadline, completed_at, priority, metadata, importance_score, last_accessed_at, access_count
  FROM moved;

  GET DIAGNOSTICS archived_count = ROW_COUNT;
  RETURN archived_count;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- ============================================================
-- DOCUMENT CATEGORIES TABLE (S45: Dynamic document classification)
-- ============================================================
CREATE TABLE IF NOT EXISTS document_categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  usage_count INTEGER DEFAULT 0,
  created_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE document_categories IS 'Dynamic document categories for automatic classification. Base categories seeded on creation.';

-- Seed 7 base categories
INSERT INTO document_categories (name, description, created_by) VALUES
  ('facture', 'Factures et notes de frais', 'system'),
  ('contrat', 'Contrats et accords', 'system'),
  ('recu', 'Recus et tickets de caisse', 'system'),
  ('note', 'Notes et memo', 'system'),
  ('identite', 'Pieces d identite et passeports', 'system'),
  ('attestation', 'Attestations et certificats', 'system'),
  ('courrier', 'Courrier administratif', 'system')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- DOCUMENTS TABLE (S45: Document storage with semantic search)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id UUID REFERENCES projects(id),
  category_id UUID REFERENCES document_categories(id),
  title TEXT,
  extracted_text TEXT,
  description TEXT,
  document_date DATE,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE documents IS 'User documents with extracted text, automatic classification, and semantic search via embeddings.';

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category_id);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(document_date DESC);
CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);

-- IVFFlat index for semantic search on extracted text embeddings
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- AGENT EVENTS TABLE (S38: Agent lifecycle event sourcing)
-- ============================================================
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

COMMENT ON TABLE agent_events IS 'Agent lifecycle events for inter-agent communication (S38).';

-- ============================================================
-- AUDIT RESULTS TABLE (Codebase audit results from heartbeat)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  global_score INTEGER NOT NULL,
  axis_scores JSONB NOT NULL DEFAULT '{}',
  findings JSONB NOT NULL DEFAULT '[]',
  task_ids_created TEXT[] DEFAULT '{}',
  trigger_type TEXT NOT NULL,
  project_id UUID REFERENCES projects(id)
);

COMMENT ON TABLE audit_results IS 'Codebase audit results with per-axis scores and findings. Populated by heartbeat audit engine.';

-- ============================================================
-- AGENT MEMORY TABLE (Role-specific persistent memory, V1)
-- Spec: SPEC-memoire-hybride-agents-bmad option D
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  agent_role TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  importance_score NUMERIC DEFAULT 50,
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536)
);

COMMENT ON TABLE agent_memory IS 'Role-specific persistent memory for BMad agents. Each role accumulates its own patterns (architectural decisions, bug patterns, planning insights). V1: flat format without inter-memory links.';
COMMENT ON COLUMN agent_memory.agent_role IS 'BMad agent role: analyst, pm, architect, dev, qa, sm, planner, explorer';
COMMENT ON COLUMN agent_memory.tags IS 'Canonical role tags (ROLE_CANONICAL_TAGS). Determined statically, no LLM call.';
COMMENT ON COLUMN agent_memory.importance_score IS 'Importance score 0-100, same decay formula as memory table (half-life 70 days).';

CREATE INDEX IF NOT EXISTS idx_agent_memory_role ON agent_memory(agent_role);
CREATE INDEX IF NOT EXISTS idx_agent_memory_role_importance ON agent_memory(agent_role, importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_created_at ON agent_memory(created_at DESC);

-- Auto-update updated_at on agent_memory
CREATE OR REPLACE FUNCTION update_agent_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER agent_memory_updated_at
  BEFORE UPDATE ON agent_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_memory_updated_at();

-- RLS: full access (consistent with memory table policy)
ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON agent_memory FOR ALL USING (true);

-- ── get_agent_memories RPC ──────────────────────────────────

-- Fetch role-specific memories ordered by importance DESC
CREATE OR REPLACE FUNCTION get_agent_memories(
  p_role TEXT,
  p_limit INT DEFAULT 15
)
RETURNS TABLE(
  id UUID,
  content TEXT,
  agent_role TEXT,
  tags TEXT[],
  importance_score NUMERIC,
  created_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    am.id,
    am.content,
    am.agent_role,
    am.tags,
    am.importance_score,
    am.created_at,
    am.last_accessed_at,
    am.access_count,
    am.metadata
  FROM public.agent_memory am
  WHERE am.agent_role = p_role
  ORDER BY am.importance_score DESC, am.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- ── Embed trigger on agent_memory (V2: for future semantic search) ──

-- Reuse the existing embed Edge Function to generate embeddings asynchronously.
-- Note: The auto_link trigger is NOT replicated (V2 scope) — memory_links FK
-- points exclusively to memory(id), incompatible with agent_memory UUIDs.
-- (See spec R14, adversarial F-DA-3/F-EC-1/F-SS-1)
CREATE OR REPLACE FUNCTION auto_embed_agent_memory()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM
    net.http_post(
      url := current_setting('app.supabase_url', true) || '/functions/v1/embed',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.supabase_service_key', true)
      ),
      body := jsonb_build_object(
        'record', jsonb_build_object('id', NEW.id::text, 'content', NEW.content, 'embedding', NEW.embedding),
        'table', 'agent_memory'
      )
    );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort: embedding failure must not block insertion
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE TRIGGER agent_memory_auto_embed
  AFTER INSERT ON agent_memory
  FOR EACH ROW
  EXECUTE FUNCTION auto_embed_agent_memory();

-- ============================================================
-- FEATURE FLAGS TABLE (Runtime feature flag persistence)
-- ============================================================
-- Replaces the file-based config/features.json for runtime state.
-- config/features.json is kept as source of default values only.
CREATE TABLE IF NOT EXISTS feature_flags (
  flag TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT DEFAULT 'system'
);

COMMENT ON TABLE feature_flags IS 'Runtime feature flags. Persists toggle state across deploys. Defaults loaded from config/features.json.';

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for feature_flags" ON feature_flags;
CREATE POLICY "Allow all for feature_flags" ON feature_flags FOR ALL USING (true);

-- Seed with default values from config/features.json
INSERT INTO feature_flags (flag, enabled, description, updated_by) VALUES
  ('heartbeat', true, 'Enable heartbeat process', 'system'),
  ('job_manager', true, 'Enable background job manager', 'system'),
  ('auto_document_search', true, 'Auto-search documents on message', 'system'),
  ('prd_to_deploy', true, 'PRD to deploy pipeline', 'system'),
  ('llmops_monitoring', true, 'LLM-Ops monitoring', 'system'),
  ('agent_role_memory', true, 'Agent role-specific memory', 'system'),
  ('sdd_auto_merge', true, 'Auto-merge SDD PRs when CI green', 'system'),
  ('sdd_auto_advance', true, 'Auto-advance SDD pipeline phases', 'system'),
  ('sdd_auto_deploy', true, 'Auto-deploy on master push', 'system'),
  ('nlu_feature_request', true, 'NLU feature request intent detection', 'system'),
  ('prompt_feedback_loop', true, 'Prompt overlay feedback loop', 'system')
ON CONFLICT (flag) DO NOTHING;
