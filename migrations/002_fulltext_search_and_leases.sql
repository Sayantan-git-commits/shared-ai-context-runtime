-- PostgreSQL migration: 002_fulltext_search_and_leases.sql
-- Implements Phase 5: Full-Text Search and Multi-Agent Task Leases

-- 1. Full-Text Search Index on memory_entries (title + content)
CREATE INDEX IF NOT EXISTS idx_memory_entries_fts 
ON memory_entries 
USING GIN (to_tsvector('english', title || ' ' || content));

-- 2. Task Lease Columns for Multi-Agent Coordination
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_token VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_agent_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_tasks_lease_expiry ON tasks(lease_expires_at);
