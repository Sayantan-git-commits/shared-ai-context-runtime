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
  const app = buildServer({ allowAnonymous: true });

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

  // 7. Test memory creation and full-text search
  await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/memories`,
    payload: {
      type: "decision",
      title: "Use PostgreSQL for durable state",
      content: "PostgreSQL 17 handles relational metadata, JSONB, and GIN full-text indexes.",
      sourceType: "unit_test",
    },
  });

  const searchRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/memories/search?q=PostgreSQL`,
  });
  assert.equal(searchRes.statusCode, 200);
  const searchResults = searchRes.json();
  assert.ok(searchResults.length >= 1);
  assert.ok(searchResults[0].title.includes("PostgreSQL"));

  // 8. Test multi-agent task leases
  // Agent A acquires lease
  const acquireRes = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/lease/acquire`,
    payload: {
      agentId: "agent-a",
      durationSeconds: 60,
    },
  });
  assert.equal(acquireRes.statusCode, 200);
  const leaseData = acquireRes.json();
  assert.ok(leaseData.leaseToken);
  assert.equal(leaseData.task.leaseAgentId, "agent-a");

  // Agent B tries to acquire same task -> returns 409 Conflict
  const conflictLeaseRes = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/lease/acquire`,
    payload: {
      agentId: "agent-b",
      durationSeconds: 60,
    },
  });
  assert.equal(conflictLeaseRes.statusCode, 409);

  // Agent A releases lease
  const releaseRes = await app.inject({
    method: "POST",
    url: `/v1/tasks/${task.id}/lease/release`,
    payload: {
      leaseToken: leaseData.leaseToken,
    },
  });
  assert.equal(releaseRes.statusCode, 200);
  const releasedTask = releaseRes.json();
  assert.equal(releasedTask.leaseToken, null);
  assert.equal(releasedTask.leaseAgentId, null);
});

test("API: authentication middleware enforces token check on protected routes", async () => {
  const secretToken = "super-secret-token-123";
  const app = buildServer({ authToken: secretToken });

  // 1. Health check is always unauthenticated
  const healthRes = await app.inject({
    method: "GET",
    url: "/health",
  });
  assert.equal(healthRes.statusCode, 200);

  // 2. Protected endpoint without token -> 401
  const unauthRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: { projectName: "secure-repo" },
  });
  assert.equal(unauthRes.statusCode, 401);
  const unauthJson = unauthRes.json();
  assert.equal(unauthJson.error, "Unauthorized");

  // 3. Protected endpoint with invalid token -> 401
  const badAuthRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { authorization: "Bearer invalid-token" },
    payload: { projectName: "secure-repo" },
  });
  assert.equal(badAuthRes.statusCode, 401);

  // 4. Protected endpoint with valid Bearer token -> 200
  const validBearerRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { authorization: `Bearer ${secretToken}` },
    payload: { projectName: "secure-repo" },
  });
  assert.equal(validBearerRes.statusCode, 200);

  // 5. Protected endpoint with valid x-api-key header -> 200
  const validApiKeyRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { "x-api-key": secretToken },
    payload: { projectName: "secure-repo" },
  });
  assert.equal(validApiKeyRes.statusCode, 200);
});

test("API: multi-tenant isolation prevents cross-organization access", async () => {
  const orgAToken = "token-tenant-a";
  const orgBToken = "token-tenant-b";
  const orgAId = "00000000-0000-0000-0000-00000000000a";
  const orgBId = "00000000-0000-0000-0000-00000000000b";

  const app = buildServer({
    authTokens: {
      [orgAToken]: orgAId,
      [orgBToken]: orgBId,
    },
  });

  // 1. Tenant A resolves project A
  const projARes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { authorization: `Bearer ${orgAToken}` },
    payload: { projectName: "tenant-a-private-repo" },
  });
  assert.equal(projARes.statusCode, 200);
  const projA = projARes.json();
  assert.equal(projA.organizationId, orgAId);

  // 2. Tenant A creates a task in Project A
  const taskARes = await app.inject({
    method: "POST",
    url: `/v1/projects/${projA.id}/tasks`,
    headers: { authorization: `Bearer ${orgAToken}` },
    payload: { title: "Confidential Tenant A Feature" },
  });
  assert.equal(taskARes.statusCode, 201);
  const taskA = taskARes.json();

  // 3. Tenant B attempts to read Project A -> 403 Forbidden
  const forbiddenProjRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${projA.id}`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenProjRes.statusCode, 403);
  const forbiddenProjJson = forbiddenProjRes.json();
  assert.equal(forbiddenProjJson.error, "Forbidden");

  // 4. Tenant B attempts to list tasks of Project A -> 403 Forbidden
  const forbiddenTasksRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${projA.id}/tasks`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenTasksRes.statusCode, 403);

  // 5. Tenant B attempts to access Tenant A's task -> 403 Forbidden
  const forbiddenTaskRes = await app.inject({
    method: "GET",
    url: `/v1/tasks/${taskA.id}`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenTaskRes.statusCode, 403);

  // 6. Tenant B attempts to acquire lease on Tenant A's task -> 403 Forbidden
  const forbiddenLeaseRes = await app.inject({
    method: "POST",
    url: `/v1/tasks/${taskA.id}/lease/acquire`,
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: { agentId: "agent-malicious", durationSeconds: 30 },
  });
  assert.equal(forbiddenLeaseRes.statusCode, 403);

  // 7. Tenant B attempts to read checkpoints of Project A -> 403 Forbidden
  const forbiddenCheckpointsRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${projA.id}/checkpoints`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenCheckpointsRes.statusCode, 403);

  // 8. Tenant B attempts to search memories of Project A -> 403 Forbidden
  const forbiddenSearchRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${projA.id}/memories/search?q=secret`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenSearchRes.statusCode, 403);

  // 9. Tenant B attempts to read audit events of Project A -> 403 Forbidden
  const forbiddenEventsRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${projA.id}/events`,
    headers: { authorization: `Bearer ${orgBToken}` },
  });
  assert.equal(forbiddenEventsRes.statusCode, 403);

  // 10. Tenant B attempts to assemble context for Project A -> 403 Forbidden
  const forbiddenAssembleRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${projA.id}/context/assemble`,
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: { formatPreference: "auto" },
  });
  assert.equal(forbiddenAssembleRes.statusCode, 403);
});

test("API: concurrent checkpoint creation maintains atomic version sequence", async () => {
  const app = buildServer({ allowAnonymous: true });

  // 1. Resolve project
  const projRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: { projectName: "concurrency-test" },
  });
  const project = projRes.json();

  // 2. Fire 10 parallel checkpoint creation requests simultaneously
  const concurrentCount = 10;
  const requests = Array.from({ length: concurrentCount }, (_, i) =>
    app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/checkpoints`,
      payload: {
        branch: "main",
        gitCommit: `commit-${i + 1}`,
        workingTree: { clean: true, changedPaths: [], untrackedPaths: [] },
        state: {
          completed: [{ description: `Step ${i + 1}`, timestamp: new Date().toISOString() }],
          pending: [],
          decisions: [],
          blockers: [],
          nextAction: `Next action ${i + 1}`,
        },
      },
    })
  );

  const responses = await Promise.all(requests);
  for (const res of responses) {
    assert.equal(res.statusCode, 201);
  }

  // 3. Verify all versions are distinct and strictly sequential (1..10)
  const versions = responses.map((r) => r.json().version).sort((a: number, b: number) => a - b);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // 4. Verify immutable list preserves all 10 checkpoints
  const listRes = await app.inject({
    method: "GET",
    url: `/v1/projects/${project.id}/checkpoints`,
  });
  assert.equal(listRes.statusCode, 200);
  const list = listRes.json();
  assert.equal(list.length, 10);
});
