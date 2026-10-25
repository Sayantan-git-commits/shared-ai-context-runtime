import test from "node:test";
import assert from "node:assert/strict";
import { buildServer, MemoryContextStore, PostgresContextStore, validateStartupConfig } from "./server.js";

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

  // 11. Cross-resource spoofing: Tenant B creates Project B
  const projBRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: { projectName: "tenant-b-repo" },
  });
  assert.equal(projBRes.statusCode, 200);
  const projB = projBRes.json();

  // Tenant B attempts to attach Tenant A's taskA to a checkpoint in Project B -> 400 Bad Request
  const crossTaskCheckpointRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${projB.id}/checkpoints`,
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: {
      taskId: taskA.id,
      branch: "main",
      nextAction: "Malicious attach",
    },
  });
  assert.equal(crossTaskCheckpointRes.statusCode, 400);

  // Tenant B attempts to emit an event in Project B referencing Tenant A's taskA -> 400 Bad Request
  const crossTaskEventRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${projB.id}/events`,
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: {
      taskId: taskA.id,
      eventType: "malicious_event",
      payload: {},
    },
  });
  assert.equal(crossTaskEventRes.statusCode, 400);

  // Tenant B attempts to assemble context in Project B with Tenant A's taskA -> 403 Forbidden
  const crossTaskAssembleRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${projB.id}/context/assemble`,
    headers: { authorization: `Bearer ${orgBToken}` },
    payload: {
      taskId: taskA.id,
      formatPreference: "auto",
    },
  });
  assert.equal(crossTaskAssembleRes.statusCode, 403);
});

test("API: health check reports ready status and fails when dependencies are unhealthy", async () => {
  // 1. Healthy in-memory store (in non-production environment)
  const healthyApp = buildServer({ allowAnonymous: true });
  const healthyRes = await healthyApp.inject({ method: "GET", url: "/health" });
  assert.equal(healthyRes.statusCode, 200);
  const healthyJson = healthyRes.json();
  assert.equal(healthyJson.status, "ok");
  assert.equal(healthyJson.ok, true);
  assert.equal(healthyJson.storeType, "memory");

  // 2. Healthy PostgreSQL store with migrations
  const mockHealthyPg: any = {
    checkHealth: async () => ({
      ok: true,
      database: true,
      migrationsApplied: 3,
      storeType: "postgres",
    }),
  };
  const pgApp = buildServer({ store: mockHealthyPg, allowAnonymous: true });
  const pgRes = await pgApp.inject({ method: "GET", url: "/health" });
  assert.equal(pgRes.statusCode, 200);
  const pgJson = pgRes.json();
  assert.equal(pgJson.status, "ok");
  assert.equal(pgJson.database, true);
  assert.equal(pgJson.migrationsApplied, 3);

  // 3. Unhealthy store (e.g. database down or migrations pending)
  const failingStore: any = {
    checkHealth: async () => ({
      ok: false,
      database: false,
      migrationsApplied: 0,
      error: "Connection refused to database",
    }),
  };
  const failingApp = buildServer({ store: failingStore, allowAnonymous: true });
  const failingRes = await failingApp.inject({ method: "GET", url: "/health" });
  assert.equal(failingRes.statusCode, 503);
  const failingJson = failingRes.json();
  assert.equal(failingJson.status, "unhealthy");
  assert.equal(failingJson.database, false);
  assert.ok(failingJson.error.includes("Connection refused"));
});

test("API: PostgresContextStore.checkHealth() catches database driver errors and sanitizes external disclosure", async () => {
  const pgStore = new PostgresContextStore("postgresql://app_user:fake_password@fake-internal-db.local:5432/ctx_db");

  // Force pool.query to throw driver error with internal host, port, and password
  (pgStore as any).pool.query = async () => {
    throw new Error("connect ECONNREFUSED 10.128.0.45:5432 - user postgres password super_secret_db_password_99");
  };

  // 1. Direct call to PostgresContextStore.checkHealth() exercises the real error catch and sanitization block
  const health = await pgStore.checkHealth();
  assert.equal(health.ok, false);
  assert.equal(health.database, false);
  assert.equal(health.migrationsApplied, 0);
  assert.equal(health.storeType, "postgres");
  assert.equal(health.error, "Database unavailable");

  const healthJson = JSON.stringify(health);
  assert.ok(!healthJson.includes("10.128.0.45"), "checkHealth() output must not leak IP");
  assert.ok(!healthJson.includes("super_secret_db_password_99"), "checkHealth() output must not leak password");
  assert.ok(!healthJson.includes("ECONNREFUSED"), "checkHealth() output must not leak driver error");

  // 2. Fastify HTTP route integration with the real PostgresContextStore instance
  const app = buildServer({ store: pgStore, allowAnonymous: true });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 503);
  const body = res.json();
  assert.equal(body.status, "unhealthy");
  assert.equal(body.error, "Database unavailable");
  assert.equal(body.database, false);

  const rawBody = res.body;
  assert.ok(!rawBody.includes("10.128.0.45"), "HTTP body must not leak internal IP");
  assert.ok(!rawBody.includes("super_secret_db_password_99"), "HTTP body must not leak password");
  assert.ok(!rawBody.includes("ECONNREFUSED"), "HTTP body must not leak raw driver errors");
  assert.ok(!rawBody.includes("fake-internal-db.local"), "HTTP body must not leak internal host");

  await pgStore.close();
});

test("API: in-memory store is rejected from production mode and reports unhealthy", async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const memStore = new MemoryContextStore();
    const health = await memStore.checkHealth();
    assert.equal(health.ok, false, "In-memory health must be false in production mode");
    assert.equal(health.storeType, "memory");

    const app = buildServer({ store: memStore, allowAnonymous: true });
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 503);
    const json = res.json();
    assert.equal(json.status, "unhealthy");
    assert.equal(json.storeType, "memory");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("API: validateStartupConfig prohibits ephemeral storage in production", () => {
  // 1. Production with no DATABASE_URL -> fatal error
  assert.throws(
    () => validateStartupConfig({ NODE_ENV: "production" }),
    /Ephemeral in-memory storage is strictly prohibited in production mode/
  );

  // 2. Production with CTX_STORE=memory -> fatal error
  assert.throws(
    () => validateStartupConfig({ NODE_ENV: "production", CTX_STORE: "memory" }),
    /Ephemeral in-memory storage is strictly prohibited in production mode/
  );

  // 3. Development without CTX_STORE -> fatal error (requires explicit flag)
  assert.throws(
    () => validateStartupConfig({ NODE_ENV: "development" }),
    /DATABASE_URL is required for durable persistence/
  );

  // 4. Development with CTX_STORE=memory -> allowed
  const devMem = validateStartupConfig({ NODE_ENV: "development", CTX_STORE: "memory" });
  assert.equal(devMem.storeType, "memory");

  // 5. Production with DATABASE_URL -> allowed postgres
  const prodPg = validateStartupConfig({ NODE_ENV: "production", DATABASE_URL: "postgresql://user:pass@host:5432/db" });
  assert.equal(prodPg.storeType, "postgres");
  assert.equal(prodPg.databaseUrl, "postgresql://user:pass@host:5432/db");
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
