import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import {
  type ContextStore,
  MemoryContextStore,
  PostgresContextStore,
  ConflictError,
} from "./store.js";

export {
  type ContextStore,
  MemoryContextStore,
  PostgresContextStore,
  ConflictError,
};
import { ContextSerializer } from "@ctx/serializers";
import {
  CreateCheckpointInputSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  CreateAgentEventInputSchema,
  AcquireTaskLeaseInputSchema,
  ReleaseTaskLeaseInputSchema,
  AssembleContextRequestSchema,
  ResolveProjectRequestSchema,
  type ContextPackage,
} from "@ctx/schemas";

export interface ServerOptions {
  store?: ContextStore;
  authToken?: string;
  authTokens?: Record<string, string>;
  allowedOrigins?: string[] | boolean;
  enableRateLimit?: boolean;
  allowAnonymous?: boolean;
}

function parseAuthTokens(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    if (raw.trim().startsWith("{")) {
      return JSON.parse(raw);
    }
  } catch {}
  // Fallback: comma separated "token:orgId" or "orgId:token"
  const tokens: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [a, b] = part.split(":").map((s) => s.trim());
    if (a && b) {
      tokens[b] = a; // token -> orgId
    }
  }
  return tokens;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: false });
  const store = options.store || new MemoryContextStore();
  const serializer = new ContextSerializer();

  // CORS Configuration: Restricted to explicit trusted origins by default
  const defaultAllowedOrigins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
  ];
  const allowedOrigins = options.allowedOrigins !== undefined
    ? options.allowedOrigins
    : (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()) : defaultAllowedOrigins);
  server.register(cors, { origin: allowedOrigins });

  if (options.enableRateLimit) {
    server.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
    });
  }

  const multiTokens = options.authTokens || parseAuthTokens(process.env.CTX_AUTH_TOKENS);
  const singleToken = options.authToken || process.env.CTX_AUTH_TOKEN;

  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }
    const authHeader = request.headers["authorization"];
    const apiKeyHeader = request.headers["x-api-key"] as string | undefined;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : apiKeyHeader;

    let orgId = "00000000-0000-0000-0000-000000000001";

    if (Object.keys(multiTokens).length > 0) {
      if (!token || !multiTokens[token]) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Valid Bearer token or x-api-key header required",
        });
      }
      orgId = multiTokens[token];
    } else if (singleToken) {
      if (!token || token !== singleToken) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Valid Bearer token or x-api-key header required",
        });
      }
    } else if (!options.allowAnonymous) {
      // In all default modes, unauthenticated requests are rejected with 401
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Authentication is required. Provide valid Bearer token or x-api-key header",
      });
    }

    (request as any).principal = {
      organizationId: orgId,
      agentId: (request.headers["x-agent-id"] as string) || "agent-cli",
    };
  });

  async function assertProjectAccess(
    projectId: string,
    request: any,
    reply: any
  ): Promise<any> {
    const project = await store.getProject(projectId);
    if (!project) {
      reply.status(404).send({ error: "Project not found" });
      return null;
    }
    const principalOrg = request.principal?.organizationId;
    if (principalOrg && project.organizationId !== principalOrg) {
      reply.status(403).send({
        error: "Forbidden",
        message: "Access denied to project outside authenticated tenant organization",
      });
      return null;
    }
    return project;
  }

  async function assertTaskAccess(
    taskId: string,
    request: any,
    reply: any
  ): Promise<any> {
    const task = await store.getTask(taskId);
    if (!task) {
      reply.status(404).send({ error: "Task not found" });
      return null;
    }
    const project = await store.getProject(task.projectId);
    const principalOrg = request.principal?.organizationId;
    if (project && principalOrg && project.organizationId !== principalOrg) {
      reply.status(403).send({
        error: "Forbidden",
        message: "Access denied to task outside authenticated tenant organization",
      });
      return null;
    }
    return task;
  }

  server.get("/health", async (_request, reply) => {
    if (typeof store.checkHealth === "function") {
      const health = await store.checkHealth();
      if (!health.ok) {
        return reply.status(503).send({
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          ...health,
        });
      }
      return {
        status: "ok",
        timestamp: new Date().toISOString(),
        ...health,
      };
    }
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Resolve project identity
  server.post("/v1/projects/resolve", async (request, reply) => {
    const parse = ResolveProjectRequestSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    const principalOrg = (request as any).principal?.organizationId;
    const project = await store.resolveProject(
      parse.data.gitRemoteUrl,
      parse.data.projectName,
      parse.data.organizationId || principalOrg
    );
    return reply.send(project);
  });

  server.get("/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;
    return reply.send(project);
  });

  // Tasks
  server.post("/v1/projects/:projectId/tasks", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const body = { ...(request.body as object), projectId };
    const parse = CreateTaskInputSchema.safeParse(body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    const task = await store.createTask(parse.data);
    return reply.status(201).send(task);
  });

  server.get("/v1/projects/:projectId/tasks", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const tasks = await store.listTasks(projectId);
    return reply.send(tasks);
  });

  server.get("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await assertTaskAccess(taskId, request, reply);
    if (!task) return;
    return reply.send(task);
  });

  server.patch("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await assertTaskAccess(taskId, request, reply);
    if (!task) return;

    const parse = UpdateTaskInputSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    try {
      const updated = await store.updateTask(taskId, parse.data);
      return reply.send(updated);
    } catch (err: any) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: "Conflict", message: err.message });
      }
      throw err;
    }
  });

  // Task Leases
  server.post("/v1/tasks/:taskId/lease/acquire", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await assertTaskAccess(taskId, request, reply);
    if (!task) return;

    const parse = AcquireTaskLeaseInputSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    try {
      const result = await store.acquireTaskLease(taskId, parse.data.agentId, parse.data.durationSeconds);
      return reply.send(result);
    } catch (err: any) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: "Conflict", message: err.message });
      }
      throw err;
    }
  });

  server.post("/v1/tasks/:taskId/lease/release", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await assertTaskAccess(taskId, request, reply);
    if (!task) return;

    const parse = ReleaseTaskLeaseInputSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    try {
      const released = await store.releaseTaskLease(taskId, parse.data.leaseToken);
      return reply.send(released);
    } catch (err: any) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: "Conflict", message: err.message });
      }
      throw err;
    }
  });

  // Checkpoints
  server.post("/v1/projects/:projectId/checkpoints", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const body = { ...(request.body as object), projectId };
    const parse = CreateCheckpointInputSchema.safeParse(body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    if (parse.data.taskId) {
      const task = await store.getTask(parse.data.taskId);
      if (!task || task.projectId !== projectId) {
        return reply.status(400).send({
          error: "Invalid task",
          message: "The specified taskId does not belong to this project",
        });
      }
    }
    const checkpoint = await store.createCheckpoint(parse.data);

    // Audit event log
    await store.recordEvent({
      projectId,
      taskId: checkpoint.taskId || undefined,
      eventType: "checkpoint_saved",
      payload: {
        checkpointId: checkpoint.id,
        version: checkpoint.version,
        branch: checkpoint.branch,
        nextAction: checkpoint.state.nextAction,
      },
    });

    return reply.status(201).send(checkpoint);
  });

  server.get("/v1/projects/:projectId/checkpoints/latest", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const checkpoint = await store.getLatestCheckpoint(projectId);
    if (!checkpoint) return reply.status(404).send({ error: "No checkpoint found" });
    return reply.send(checkpoint);
  });

  server.get("/v1/projects/:projectId/checkpoints", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const checkpoints = await store.listCheckpoints(projectId);
    return reply.send(checkpoints);
  });

  // Memories
  server.get("/v1/projects/:projectId/memories", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const memories = await store.listMemories(projectId);
    return reply.send(memories);
  });

  server.post("/v1/projects/:projectId/memories", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const body = { ...(request.body as object), projectId };
    const memory = await store.createMemory(body as any);
    return reply.status(201).send(memory);
  });

  server.get("/v1/projects/:projectId/memories/search", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const { q, limit } = request.query as { q?: string; limit?: string };
    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: "Query parameter 'q' is required" });
    }
    const results = await store.searchMemories(projectId, q.trim(), limit ? Number(limit) : 10);
    return reply.send(results);
  });

  // Events
  server.get("/v1/projects/:projectId/events", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const { taskId } = request.query as { taskId?: string };
    const events = await store.listEvents(projectId, taskId);
    return reply.send(events);
  });

  server.post("/v1/projects/:projectId/events", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;

    const body = { ...(request.body as object), projectId };
    const parse = CreateAgentEventInputSchema.safeParse(body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    if (parse.data.taskId) {
      const task = await store.getTask(parse.data.taskId);
      if (!task || task.projectId !== projectId) {
        return reply.status(400).send({
          error: "Invalid task",
          message: "The specified taskId does not belong to this project",
        });
      }
    }
    const event = await store.recordEvent(parse.data);
    return reply.status(201).send(event);
  });

  // Context Assembly & TOON Optimization
  server.post("/v1/projects/:projectId/context/assemble", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await assertProjectAccess(projectId, request, reply);
    if (!project) return;
    const parse = AssembleContextRequestSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }

    const checkpoint = await store.getLatestCheckpoint(projectId);
    if (parse.data.taskId) {
      const explicitTask = await store.getTask(parse.data.taskId);
      if (!explicitTask || explicitTask.projectId !== projectId) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "The requested taskId does not belong to this project",
        });
      }
    }
    const taskId = parse.data.taskId || checkpoint?.taskId || undefined;
    const task = taskId ? await store.getTask(taskId) : null;
    const memories = await store.listMemories(projectId);
    const recentEvents = await store.listEvents(projectId, taskId);

    // 1. Task-relevance memory ranking (prioritize task-linked and keyword-matching memories)
    const taskKeywords = [
      ...(task?.title?.toLowerCase().split(/\s+/) || []),
      ...(task?.nextAction?.toLowerCase().split(/\s+/) || []),
    ].filter((w) => w.length > 3);

    const scoredMemories = memories.map((mem) => {
      let score = 0;
      if (task && (mem.structuredContent as any)?.taskId === task.id) score += 50;
      const titleLower = mem.title.toLowerCase();
      for (const kw of taskKeywords) {
        if (titleLower.includes(kw)) score += 10;
      }
      return { mem, score };
    });

    scoredMemories.sort((a, b) => b.score - a.score);
    const topMemories = scoredMemories.slice(0, 15).map((s) => s.mem);

    const facts: Record<string, unknown> = {};
    const decisions: Array<Record<string, unknown>> = [];
    for (const mem of topMemories) {
      if (mem.type === "fact") facts[mem.title] = mem.content;
      if (mem.type === "decision") decisions.push({ title: mem.title, content: mem.content });
    }

    // 2. Establish whether live repository state matches checkpoint state
    let gitDriftDetected = false;
    const instructions: string[] = [
      "Resume task from the verified checkpoint below.",
      "Ensure git working tree and tests pass before concluding.",
    ];

    if (checkpoint && parse.data.currentGitState) {
      const cur = parse.data.currentGitState as any;
      const isBranchDrift = cur.branch && checkpoint.branch !== cur.branch;
      const isCommitDrift = cur.headCommit && checkpoint.gitCommit && checkpoint.gitCommit !== cur.headCommit;
      const isCleanDrift = cur.clean !== undefined && checkpoint.workingTree.clean !== cur.clean;
      if (isBranchDrift || isCommitDrift || isCleanDrift) {
        gitDriftDetected = true;
        instructions.unshift(
          `[REPO DRIFT WARNING] Working tree has diverged from checkpoint (checkpoint was branch '${checkpoint.branch}', commit '${checkpoint.gitCommit?.slice(0, 7) || "none"}'). Inspect diff before changes.`
        );
      }
    }

    // Assemble ContextPackage
    const pkg: ContextPackage = {
      schemaVersion: 1,
      projectId: project.id,
      projectName: project.name,
      taskId: task?.id,
      checkpointVersion: checkpoint?.version,
      instructions,
      facts,
      decisions,
      taskState: {
        title: task?.title || "Active session",
        status: task?.status || checkpoint?.validityStatus || "in_progress",
        nextAction: task?.nextAction || checkpoint?.state.nextAction || "",
        completed: checkpoint?.state.completed || [],
        pending: checkpoint?.state.pending || [],
        blockers: checkpoint?.state.blockers || [],
      },
      recentEvents: recentEvents.slice(0, 5).map((e) => ({
        type: e.eventType,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      gitState: checkpoint
        ? {
            branch: checkpoint.branch,
            gitCommit: checkpoint.gitCommit,
            clean: checkpoint.workingTree.clean,
            changedPaths: checkpoint.workingTree.changedPaths,
          }
        : undefined,
    };

    // Run serialization optimizer with token budget pruning
    const serialization = await serializer.encode(
      pkg,
      parse.data.formatPreference,
      parse.data.tokenBudget
    );

    // Audit context handoff event
    await store.recordEvent({
      projectId,
      taskId: task?.id,
      eventType: "context_assembled",
      payload: {
        format: serialization.format,
        estimatedTokens: serialization.estimatedTokens,
        tokenBudget: parse.data.tokenBudget,
        budgetExceeded: serialization.budgetExceeded,
        prunedItemsCount: serialization.prunedItemsCount,
        gitDriftDetected,
      },
    });

    return reply.send({
      contextId: randomUUID(),
      projectId: project.id,
      taskId: task?.id,
      checkpointVersion: checkpoint?.version,
      format: serialization.format,
      content: serialization.serialized,
      estimatedTokens: serialization.estimatedTokens,
      baselineTokens: serialization.baselineTokens,
      savingsPercent: serialization.savingsPercent,
      tokenBudget: parse.data.tokenBudget,
      budgetExceeded: serialization.budgetExceeded,
      prunedItemsCount: serialization.prunedItemsCount,
      gitDriftDetected,
      sources: checkpoint ? [{ type: "checkpoint", id: checkpoint.id }] : [],
    });
  });

  return server;
}
