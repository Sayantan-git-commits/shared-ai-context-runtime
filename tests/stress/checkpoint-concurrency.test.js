import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";

test("Stress: Sustained concurrent checkpoint writes maintain monotonic versions without collisions", async () => {
  const store = new PostgresContextStore(DATABASE_URL);
  const app = buildServer({ store, allowAnonymous: true });
  const pool = new Pool({ connectionString: DATABASE_URL });

  // 1. Resolve a unique project for this stress test run
  const projectName = `stress-project-${Date.now()}`;
  const resolveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: {
      projectName,
      gitRemoteUrl: `git@github.com:stress/${projectName}.git`,
    },
  });
  assert.equal(resolveRes.statusCode, 200);
  const project = resolveRes.json();

  // 2. Create an initial task
  const taskRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/tasks`,
    payload: {
      title: "Stress test task contention",
      status: "in_progress",
      nextAction: "execute concurrent checkpoint batch",
    },
  });
  assert.equal(taskRes.statusCode, 201);
  const task = taskRes.json();

  // 3. Concurrently fire 50 checkpoint writes against the same project/task
  const CONCURRENT_COUNT = 50;
  console.log(`\nStarting stress test: ${CONCURRENT_COUNT} concurrent writes to project ${project.id}...`);

  const t0 = performance.now();
  const writePromises = Array.from({ length: CONCURRENT_COUNT }, async (_, i) => {
    return app.inject({
      method: "POST",
      url: `/v1/projects/${project.id}/checkpoints`,
      payload: {
        taskId: task.id,
        branch: "feature/stress-contention",
        gitCommit: `commit_${i + 1}`,
        workingTree: {
          clean: true,
          changedPaths: [],
          untrackedPaths: [],
        },
        state: {
          completed: [{ description: `Step ${i + 1} completed`, evidence: `test_${i + 1}_passed` }],
          pending: [],
          decisions: [],
          blockers: [],
          nextAction: `Proceed to step ${i + 2}`,
        },
      },
    });
  });

  const responses = await Promise.all(writePromises);
  const elapsedMs = performance.now() - t0;
  console.log(`Completed ${CONCURRENT_COUNT} concurrent writes in ${elapsedMs.toFixed(2)}ms (${(elapsedMs / CONCURRENT_COUNT).toFixed(2)}ms/op avg).`);

  // 4. Verify all HTTP responses
  let successCount = 0;
  let conflictCount = 0;
  let error5xxCount = 0;
  const versionsAllocated = [];

  for (const res of responses) {
    if (res.statusCode === 201) {
      successCount++;
      const body = res.json();
      versionsAllocated.push(body.version);
    } else {
      console.log(`Failed response status: ${res.statusCode}, body:`, res.body);
      if (res.statusCode === 409) {
        conflictCount++;
      } else if (res.statusCode >= 500) {
        error5xxCount++;
      }
    }
  }

  assert.equal(error5xxCount, 0, `Expected 0 5xx errors, but got ${error5xxCount}`);
  assert.equal(successCount, CONCURRENT_COUNT, `Expected all ${CONCURRENT_COUNT} writes to be accepted`);

  // 5. Verify versions are strictly monotonic and sequential: 1 to CONCURRENT_COUNT
  versionsAllocated.sort((a, b) => a - b);
  assert.equal(versionsAllocated.length, CONCURRENT_COUNT);
  for (let i = 0; i < CONCURRENT_COUNT; i++) {
    assert.equal(versionsAllocated[i], i + 1, `Version mismatch at index ${i}: expected ${i + 1}, got ${versionsAllocated[i]}`);
  }

  // 6. Verify directly in PostgreSQL storage
  const dbRows = await pool.query(
    "SELECT version, branch, git_commit FROM checkpoints WHERE project_id = $1 ORDER BY version ASC",
    [project.id]
  );
  assert.equal(dbRows.rows.length, CONCURRENT_COUNT);
  for (let i = 0; i < CONCURRENT_COUNT; i++) {
    assert.equal(dbRows.rows[i].version, i + 1);
  }

  // 7. Test Stale-Version / Optimistic Lock Task Updates
  // Current task version is 1; trying to update with expectedVersion: 99
  const taskUpdateStale = await app.inject({
    method: "PATCH",
    url: `/v1/tasks/${task.id}`,
    payload: {
      nextAction: "competing write with stale version",
      expectedVersion: 99,
    },
  });
  assert.equal(taskUpdateStale.statusCode, 409);
  assert.ok(taskUpdateStale.json().error.includes("Conflict"));

  // Valid update with expectedVersion: 1 succeeds and bumps to version 2
  const taskUpdate1 = await app.inject({
    method: "PATCH",
    url: `/v1/tasks/${task.id}`,
    payload: {
      nextAction: "first updated next action",
      expectedVersion: 1,
    },
  });
  assert.equal(taskUpdate1.statusCode, 200);
  assert.equal(taskUpdate1.json().currentVersion, 2);

  await store.close();
  await pool.end();
  console.log("✓ Concurrency stress & optimistic locking test passed with zero data loss or collisions.");
});
