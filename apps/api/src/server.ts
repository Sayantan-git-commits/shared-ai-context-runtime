import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import {
  type ContextStore,
  MemoryContextStore,
  ConflictError,
} from "./store.js";
import { ContextSerializer } from "@ctx/serializers";
import {
  CreateCheckpointInputSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  CreateAgentEventInputSchema,
  AssembleContextRequestSchema,
  ResolveProjectRequestSchema,
  type ContextPackage,
} from "@ctx/schemas";

export interface ServerOptions {
  store?: ContextStore;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: false });
  const store = options.store || new MemoryContextStore();
  const serializer = new ContextSerializer();

  server.register(cors, { origin: true });

  server.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Resolve project identity
  server.post("/v1/projects/resolve", async (request, reply) => {
    const parse = ResolveProjectRequestSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    const project = await store.resolveProject(parse.data.gitRemoteUrl, parse.data.projectName);
    return reply.send(project);
  });

  server.get("/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await store.getProject(projectId);
    if (!project) return reply.status(404).send({ error: "Project not found" });
    return reply.send(project);
  });

  // Tasks
  server.post("/v1/projects/:projectId/tasks", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
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
    const tasks = await store.listTasks(projectId);
    return reply.send(tasks);
  });

  server.get("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = await store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    return reply.send(task);
  });

  server.patch("/v1/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
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

  // Checkpoints
  server.post("/v1/projects/:projectId/checkpoints", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = { ...(request.body as object), projectId };
    const parse = CreateCheckpointInputSchema.safeParse(body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
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
    const checkpoint = await store.getLatestCheckpoint(projectId);
    if (!checkpoint) return reply.status(404).send({ error: "No checkpoint found" });
    return reply.send(checkpoint);
  });

  server.get("/v1/projects/:projectId/checkpoints", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const checkpoints = await store.listCheckpoints(projectId);
    return reply.send(checkpoints);
  });

  // Memories
  server.get("/v1/projects/:projectId/memories", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const memories = await store.listMemories(projectId);
    return reply.send(memories);
  });

  server.post("/v1/projects/:projectId/memories", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = { ...(request.body as object), projectId };
    const memory = await store.createMemory(body as any);
    return reply.status(201).send(memory);
  });

  // Events
  server.get("/v1/projects/:projectId/events", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { taskId } = request.query as { taskId?: string };
    const events = await store.listEvents(projectId, taskId);
    return reply.send(events);
  });

  server.post("/v1/projects/:projectId/events", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = { ...(request.body as object), projectId };
    const parse = CreateAgentEventInputSchema.safeParse(body);
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }
    const event = await store.recordEvent(parse.data);
    return reply.status(201).send(event);
  });

  // Context Assembly & TOON Optimization
  server.post("/v1/projects/:projectId/context/assemble", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const parse = AssembleContextRequestSchema.safeParse(request.body || {});
    if (!parse.success) {
      return reply.status(400).send({ error: parse.error.format() });
    }

    const project = await store.getProject(projectId);
    if (!project) return reply.status(404).send({ error: "Project not found" });

    const checkpoint = await store.getLatestCheckpoint(projectId);
    const taskId = parse.data.taskId || checkpoint?.taskId || undefined;
    const task = taskId ? await store.getTask(taskId) : null;
    const memories = await store.listMemories(projectId);
    const recentEvents = await store.listEvents(projectId, taskId);

    // Group memories
    const facts: Record<string, unknown> = {};
    const decisions: Array<Record<string, unknown>> = [];
    for (const mem of memories) {
      if (mem.type === "fact") facts[mem.title] = mem.content;
      if (mem.type === "decision") decisions.push({ title: mem.title, content: mem.content });
    }

    // Assemble ContextPackage
    const pkg: ContextPackage = {
      schemaVersion: 1,
      projectId: project.id,
      projectName: project.name,
      taskId: task?.id,
      checkpointVersion: checkpoint?.version,
      instructions: [
        "Resume task from the verified checkpoint below.",
        "Ensure git working tree and tests pass before concluding.",
      ],
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
      sources: checkpoint ? [{ type: "checkpoint", id: checkpoint.id }] : [],
    });
  });

  return server;
}
