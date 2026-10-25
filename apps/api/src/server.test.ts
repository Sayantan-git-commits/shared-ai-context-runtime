import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "./server.js";

test("API: health check returns ok", async () => {
  const app = buildServer();
  const res = await app.inject({
    method: "GET",
    url: "/health",
  });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.status, "ok");
});

test("API: resolve project and checkpoint workflow", async () => {
  const app = buildServer();

  // 1. Resolve project
  const projRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: {
      gitRemoteUrl: "git@github.com:example/repo.git",
      projectName: "repo",
    },
  });
  assert.equal(projRes.statusCode, 200);
  const project = projRes.json();
  assert.ok(project.id);
  assert.equal(project.name, "repo");

  // 2. Create a task
  const taskRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/tasks`,
    payload: {
      title: "Add authentication",
      nextAction: "Inspect login endpoint",
      status: "in_progress",
    },
  });
  assert.equal(taskRes.statusCode, 201);
  const task = taskRes.json();
  assert.ok(task.id);

  // 3. Save a checkpoint
  const ckptRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/checkpoints`,
    payload: {
      taskId: task.id,
      branch: "feature/auth",
      gitCommit: "1234567",
      workingTree: {
        clean: false,
        changedPaths: ["src/auth.ts"],
        untrackedPaths: [],
      },
      state: {
        completed: [{ description: "Initial setup", timestamp: new Date().toISOString() }],
        pending: ["Token rotation"],
        decisions: [{ decision: "Use JWT" }],
        blockers: [],
        nextAction: "Inspect login endpoint",
      },
    },
  });
  assert.equal(ckptRes.statusCode, 201);
  const checkpoint = ckptRes.json();
  assert.equal(checkpoint.version, 1);

  // 4. Assemble context with TOON optimization
  const assembleRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/context/assemble`,
    payload: {
      taskId: task.id,
      formatPreference: "auto",
    },
  });
  assert.equal(assembleRes.statusCode, 200);
  const assemble = assembleRes.json();
  assert.ok(assemble.content);
  assert.ok(["toon", "json"].includes(assemble.format));
  assert.equal(assemble.checkpointVersion, 1);
  assert.ok(assemble.estimatedTokens > 0);

  // 5. Test optimistic locking conflict (HTTP 409)
  // Current task version is 1; trying to update with expectedVersion: 99
  const conflictRes = await app.inject({
    method: "PATCH",
    url: `/v1/tasks/${task.id}`,
    payload: {
      nextAction: "Stale update",
      expectedVersion: 99,
    },
  });
  assert.equal(conflictRes.statusCode, 409);
  const conflictJson = conflictRes.json();
  assert.equal(conflictJson.error, "Conflict");

  // Valid update with expectedVersion: 1 succeeds and bumps to version 2
  const validUpdateRes = await app.inject({
    method: "PATCH",
    url: `/v1/tasks/${task.id}`,
    payload: {
      nextAction: "Valid update",
      expectedVersion: 1,
    },
  });
  assert.equal(validUpdateRes.statusCode, 200);
  const updatedTask = validUpdateRes.json();
  assert.equal(updatedTask.currentVersion, 2);

  // 6. Test event audit stream
  const eventsRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/events`,
  });
  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json();
  assert.ok(events.length >= 2);
  const eventTypes = events.map((e: any) => e.eventType);
  assert.ok(eventTypes.includes("checkpoint_saved"));
  assert.ok(eventTypes.includes("context_assembled"));
});
