import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;
import type {
  Project,
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  Checkpoint,
  CreateCheckpointInput,
  MemoryEntry,
  MemoryType,
  AgentEvent,
  CreateAgentEventInput,
} from "@ctx/schemas";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface ContextStore {
  resolveProject(gitRemoteUrl?: string, projectName?: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  listTasks(projectId: string): Promise<Task[]>;
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  getLatestCheckpoint(projectId: string): Promise<Checkpoint | null>;
  listCheckpoints(projectId: string): Promise<Checkpoint[]>;
  createMemory(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  listMemories(projectId: string, type?: MemoryType): Promise<MemoryEntry[]>;
  recordEvent(input: CreateAgentEventInput): Promise<AgentEvent>;
  listEvents(projectId: string, taskId?: string): Promise<AgentEvent[]>;
}

export class MemoryContextStore implements ContextStore {
  private projects: Map<string, Project> = new Map();
  private tasks: Map<string, Task> = new Map();
  private checkpoints: Map<string, Checkpoint[]> = new Map(); // projectId -> checkpoints
  private memories: Map<string, MemoryEntry[]> = new Map(); // projectId -> memories
  private events: Map<string, AgentEvent[]> = new Map(); // projectId -> events

  public async resolveProject(gitRemoteUrl?: string, projectName?: string): Promise<Project> {
    // Look up by git remote or name
    for (const proj of this.projects.values()) {
      if (gitRemoteUrl && proj.gitRemoteNormalized === gitRemoteUrl) {
        return proj;
      }
      if (projectName && proj.name === projectName) {
        return proj;
      }
    }

    // Auto-create default project for development
    const now = new Date().toISOString();
    const newProject: Project = {
      id: randomUUID(),
      organizationId: "00000000-0000-0000-0000-000000000001",
      name: projectName || "default-project",
      gitRemoteNormalized: gitRemoteUrl || null,
      defaultBranch: "main",
      config: {},
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(newProject.id, newProject);
    return newProject;
  }

  public async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) || null;
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      status: input.status || "pending",
      nextAction: input.nextAction || "",
      currentVersion: 1,
      priority: input.priority || "medium",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  public async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) || null;
  }

  public async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

    if (input.expectedVersion !== undefined && task.currentVersion !== input.expectedVersion) {
      throw new ConflictError(
        `Conflict: expected task version ${input.expectedVersion}, but current version is ${task.currentVersion}`
      );
    }

    const { expectedVersion, ...rest } = input;
    const updated: Task = {
      ...task,
      ...rest,
      currentVersion: task.currentVersion + 1,
      updatedAt: new Date().toISOString(),
      completedAt: input.status === "completed" ? new Date().toISOString() : task.completedAt,
    };
    this.tasks.set(id, updated);
    return updated;
  }

  public async listTasks(projectId: string): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.projectId === projectId);
  }

  public async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    const projectCheckpoints = this.checkpoints.get(input.projectId) || [];
    const nextVersion = projectCheckpoints.length + 1;
    const now = new Date().toISOString();

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId || null,
      version: nextVersion,
      branch: input.branch,
      gitCommit: input.gitCommit || null,
      workingTree: input.workingTree,
      state: input.state,
      createdByAgentId: input.createdByAgentId || null,
      createdAt: now,
      validityStatus: "valid",
      idempotencyKey: input.idempotencyKey || null,
    };

    projectCheckpoints.push(checkpoint);
    this.checkpoints.set(input.projectId, projectCheckpoints);
    return checkpoint;
  }

  public async getLatestCheckpoint(projectId: string): Promise<Checkpoint | null> {
    const list = this.checkpoints.get(projectId) || [];
    if (list.length === 0) return null;
    return list[list.length - 1];
  }

  public async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
    return [...(this.checkpoints.get(projectId) || [])].reverse();
  }

  public async createMemory(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">
  ): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const memory: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    };
    const list = this.memories.get(entry.projectId) || [];
    list.push(memory);
    this.memories.set(entry.projectId, list);
    return memory;
  }

  public async listMemories(projectId: string, type?: MemoryType): Promise<MemoryEntry[]> {
    const list = this.memories.get(projectId) || [];
    return list.filter((m) => !m.isDeleted && (!type || m.type === type));
  }

  public async recordEvent(input: CreateAgentEventInput): Promise<AgentEvent> {
    const now = new Date().toISOString();
    const event: AgentEvent = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId || null,
      agentId: input.agentId || null,
      eventType: input.eventType,
      payload: input.payload || {},
      createdAt: now,
      correlationId: input.correlationId || null,
      idempotencyKey: input.idempotencyKey || null,
    };
    const list = this.events.get(input.projectId) || [];
    list.push(event);
    this.events.set(input.projectId, list);
    return event;
  }

  public async listEvents(projectId: string, taskId?: string): Promise<AgentEvent[]> {
    const list = this.events.get(projectId) || [];
    return list.filter((e) => !taskId || e.taskId === taskId).reverse();
  }
}

export class PostgresContextStore implements ContextStore {
  private pool: any;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  public async resolveProject(gitRemoteUrl?: string, projectName?: string): Promise<Project> {
    if (gitRemoteUrl) {
      const res = await this.pool.query(
        "SELECT * FROM projects WHERE git_remote_normalized = $1 LIMIT 1",
        [gitRemoteUrl]
      );
      if (res.rows.length > 0) return this.mapProject(res.rows[0]);
    }
    if (projectName) {
      const res = await this.pool.query("SELECT * FROM projects WHERE name = $1 LIMIT 1", [
        projectName,
      ]);
      if (res.rows.length > 0) return this.mapProject(res.rows[0]);
    }

    // Create default project & org
    const orgRes = await this.pool.query(
      "INSERT INTO organizations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
      ["Default Org"]
    );
    const orgId = orgRes.rows[0]?.id || "00000000-0000-0000-0000-000000000001";

    const insertRes = await this.pool.query(
      `INSERT INTO projects (organization_id, name, git_remote_normalized, default_branch, config_json)
       VALUES ($1, $2, $3, 'main', '{}'::jsonb)
       RETURNING *`,
      [orgId, projectName || "default-project", gitRemoteUrl || null]
    );
    return this.mapProject(insertRes.rows[0]);
  }

  public async getProject(id: string): Promise<Project | null> {
    const res = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    if (res.rows.length === 0) return null;
    return this.mapProject(res.rows[0]);
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    const res = await this.pool.query(
      `INSERT INTO tasks (project_id, title, status, next_action, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.projectId,
        input.title,
        input.status || "pending",
        input.nextAction || "",
        input.priority || "medium",
      ]
    );
    return this.mapTask(res.rows[0]);
  }

  public async getTask(id: string): Promise<Task | null> {
    const res = await this.pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (res.rows.length === 0) return null;
    return this.mapTask(res.rows[0]);
  }

  public async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    if (input.expectedVersion !== undefined) {
      const res = await this.pool.query(
        `UPDATE tasks
         SET title = COALESCE($2, title),
             status = COALESCE($3, status),
             next_action = COALESCE($4, next_action),
             current_version = current_version + 1,
             updated_at = NOW(),
             completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END
         WHERE id = $1 AND current_version = $5
         RETURNING *`,
        [id, input.title, input.status, input.nextAction, input.expectedVersion]
      );
      if (res.rows.length === 0) {
        const existing = await this.getTask(id);
        if (!existing) throw new Error(`Task ${id} not found`);
        throw new ConflictError(
          `Conflict: expected task version ${input.expectedVersion}, but current version is ${existing.currentVersion}`
        );
      }
      return this.mapTask(res.rows[0]);
    }

    const res = await this.pool.query(
      `UPDATE tasks
       SET title = COALESCE($2, title),
           status = COALESCE($3, status),
           next_action = COALESCE($4, next_action),
           current_version = current_version + 1,
           updated_at = NOW(),
           completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END
       WHERE id = $1
       RETURNING *`,
      [id, input.title, input.status, input.nextAction]
    );
    if (res.rows.length === 0) throw new Error(`Task ${id} not found`);
    return this.mapTask(res.rows[0]);
  }

  public async listTasks(projectId: string): Promise<Task[]> {
    const res = await this.pool.query(
      "SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );
    return res.rows.map((r: any) => this.mapTask(r));
  }

  public async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    // Determine next version atomically
    const verRes = await this.pool.query(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM checkpoints WHERE project_id = $1",
      [input.projectId]
    );
    const nextVer = verRes.rows[0].next_ver;

    const res = await this.pool.query(
      `INSERT INTO checkpoints (
         project_id, task_id, version, branch, git_commit,
         working_tree_summary, state_json, created_by_agent_id, idempotency_key
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        input.projectId,
        input.taskId || null,
        nextVer,
        input.branch,
        input.gitCommit || null,
        JSON.stringify(input.workingTree),
        JSON.stringify(input.state),
        input.createdByAgentId || null,
        input.idempotencyKey || null,
      ]
    );
    return this.mapCheckpoint(res.rows[0]);
  }

  public async getLatestCheckpoint(projectId: string): Promise<Checkpoint | null> {
    const res = await this.pool.query(
      "SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY version DESC LIMIT 1",
      [projectId]
    );
    if (res.rows.length === 0) return null;
    return this.mapCheckpoint(res.rows[0]);
  }

  public async listCheckpoints(projectId: string): Promise<Checkpoint[]> {
    const res = await this.pool.query(
      "SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY version DESC",
      [projectId]
    );
    return res.rows.map((r: any) => this.mapCheckpoint(r));
  }

  public async createMemory(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">
  ): Promise<MemoryEntry> {
    const res = await this.pool.query(
      `INSERT INTO memory_entries (
         project_id, type, title, content, structured_content,
         source_type, source_ref, confidence
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING *`,
      [
        entry.projectId,
        entry.type,
        entry.title,
        entry.content,
        entry.structuredContent ? JSON.stringify(entry.structuredContent) : null,
        entry.sourceType,
        entry.sourceRef || null,
        entry.confidence || null,
      ]
    );
    return this.mapMemory(res.rows[0]);
  }

  public async listMemories(projectId: string, type?: MemoryType): Promise<MemoryEntry[]> {
    const query = type
      ? "SELECT * FROM memory_entries WHERE project_id = $1 AND type = $2 AND is_deleted = false"
      : "SELECT * FROM memory_entries WHERE project_id = $1 AND is_deleted = false";
    const params = type ? [projectId, type] : [projectId];
    const res = await this.pool.query(query, params);
    return res.rows.map((r: any) => this.mapMemory(r));
  }

  public async recordEvent(input: CreateAgentEventInput): Promise<AgentEvent> {
    const res = await this.pool.query(
      `INSERT INTO agent_events (
         project_id, task_id, agent_id, event_type, payload, correlation_id, idempotency_key
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        input.projectId,
        input.taskId || null,
        input.agentId || null,
        input.eventType,
        JSON.stringify(input.payload || {}),
        input.correlationId || null,
        input.idempotencyKey || null,
      ]
    );
    return this.mapEvent(res.rows[0]);
  }

  public async listEvents(projectId: string, taskId?: string): Promise<AgentEvent[]> {
    const query = taskId
      ? "SELECT * FROM agent_events WHERE project_id = $1 AND task_id = $2 ORDER BY created_at DESC"
      : "SELECT * FROM agent_events WHERE project_id = $1 ORDER BY created_at DESC";
    const params = taskId ? [projectId, taskId] : [projectId];
    const res = await this.pool.query(query, params);
    return res.rows.map((r: any) => this.mapEvent(r));
  }

  private mapEvent(row: any): AgentEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      eventType: row.event_type,
      payload: row.payload || {},
      createdAt: row.created_at.toISOString(),
      correlationId: row.correlation_id,
      idempotencyKey: row.idempotency_key,
    };
  }

  private mapProject(row: any): Project {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      gitRemoteNormalized: row.git_remote_normalized,
      defaultBranch: row.default_branch,
      config: row.config_json || {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapTask(row: any): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      assignedAgentId: row.assigned_agent_id,
      nextAction: row.next_action,
      currentVersion: row.current_version,
      priority: row.priority,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    };
  }

  private mapCheckpoint(row: any): Checkpoint {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      version: row.version,
      branch: row.branch,
      gitCommit: row.git_commit,
      workingTree: row.working_tree_summary,
      state: row.state_json,
      createdByAgentId: row.created_by_agent_id,
      createdAt: row.created_at.toISOString(),
      validityStatus: row.validity_status,
      idempotencyKey: row.idempotency_key,
    };
  }

  private mapMemory(row: any): MemoryEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      title: row.title,
      content: row.content,
      structuredContent: row.structured_content,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      confidence: row.confidence,
      createdByAgentId: row.created_by_agent_id,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      isDeleted: row.is_deleted,
    };
  }
}
