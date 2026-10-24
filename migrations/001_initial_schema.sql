-- PostgreSQL migration: 001_initial_schema.sql
-- Implements Section 7 of Shared AI Context Runtime (ctx) architecture

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    identity_provider VARCHAR(100) NOT NULL,
    provider_subject VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_provider_subject UNIQUE (identity_provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    git_remote_normalized VARCHAR(500),
    default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
    config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_git_remote ON projects(git_remote_normalized);

CREATE TABLE IF NOT EXISTS project_memberships (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(100) NOT NULL,
    client_type VARCHAR(100) NOT NULL,
    client_version VARCHAR(50),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    next_action TEXT NOT NULL DEFAULT '',
    current_version INTEGER NOT NULL DEFAULT 1,
    priority VARCHAR(50) NOT NULL DEFAULT 'medium',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    version INTEGER NOT NULL,
    branch VARCHAR(255) NOT NULL,
    git_commit VARCHAR(100),
    working_tree_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    validity_status VARCHAR(50) NOT NULL DEFAULT 'valid',
    idempotency_key VARCHAR(255),
    CONSTRAINT uq_checkpoints_project_version UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created ON checkpoints(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- 'fact', 'decision', 'procedure', 'note'
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    structured_content JSONB,
    source_type VARCHAR(100) NOT NULL,
    source_ref VARCHAR(255),
    confidence DOUBLE PRECISION,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_memory_project_type ON memory_entries(project_id, type);

CREATE TABLE IF NOT EXISTS agent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    correlation_id VARCHAR(255),
    idempotency_key VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_project ON agent_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    client_type VARCHAR(100) NOT NULL,
    model_id VARCHAR(100),
    serialization_format VARCHAR(50) NOT NULL,
    estimated_input_tokens INTEGER NOT NULL,
    actual_input_tokens INTEGER,
    assembly_latency_ms INTEGER NOT NULL,
    serialization_latency_ms INTEGER NOT NULL,
    resume_outcome VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
