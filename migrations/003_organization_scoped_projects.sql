-- Migration: 003_organization_scoped_projects.sql
-- Enforces organization-level scoping for project names and git remotes.

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_name 
ON projects (organization_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_org_remote 
ON projects (organization_id, git_remote_normalized) 
WHERE git_remote_normalized IS NOT NULL;
