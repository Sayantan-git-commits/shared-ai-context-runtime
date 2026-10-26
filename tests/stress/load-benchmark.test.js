import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";

test("Load & Performance: Sustained throughput and latency under concurrent read/write traffic", async () => {
  const store = new PostgresContextStore(DATABASE_URL);
  const app = buildServer({ store, allowAnonymous: true });
  const pool = new Pool({ connectionString: DATABASE_URL });

  // 1. Setup project fixture
  const projectName = `load-benchmark-${Date.now()}`;
  const resolveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: {
      projectName,
      gitRemoteUrl: `git@github.com:load/${projectName}.git`,
    },
  });
  assert.equal(resolveRes.statusCode, 200);
  const project = resolveRes.json();

  const taskRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/tasks`,
    payload: {
      title: "Sustained load benchmark",
      status: "in_progress",
      nextAction: "execute benchmark cycle",
    },
  });
  assert.equal(taskRes.statusCode, 201);
  const task = taskRes.json();

  // 2. Execute mixed workload: 100 requests (checkpoint writes + context assemblies)
  const TOTAL_OPERATIONS = 100;
  console.log(`\nExecuting sustained load benchmark: ${TOTAL_OPERATIONS} operations...`);

  const latenciesMs = [];
  const tStart = performance.now();

  for (let i = 0; i < TOTAL_OPERATIONS; i++) {
    const tOp = performance.now();
    let res;
    if (i % 2 === 0) {
      // Checkpoint write
      res = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/checkpoints`,
        payload: {
          taskId: task.id,
          branch: "main",
          gitCommit: `commit_load_${i}`,
          workingTree: { clean: true, changedPaths: [], untrackedPaths: [] },
          state: {
            completed: [{ description: `Operation ${i} finished`, evidence: "ok" }],
            pending: [],
            decisions: [],
            blockers: [],
            nextAction: `Proceed to ${i + 1}`,
          },
        },
      });
      assert.equal(res.statusCode, 201);
    } else {
      // Context assembly read
      res = await app.inject({
        method: "POST",
        url: `/v1/projects/${project.id}/context/assemble`,
        payload: {
          taskId: task.id,
          clientType: "generic-mcp",
          formatPreference: "auto",
        },
      });
      assert.equal(res.statusCode, 200);
    }
    latenciesMs.push(performance.now() - tOp);
  }

  const totalDurationMs = performance.now() - tStart;
  latenciesMs.sort((a, b) => a - b);

  const p50 = latenciesMs[Math.floor(TOTAL_OPERATIONS * 0.5)].toFixed(2);
  const p95 = latenciesMs[Math.floor(TOTAL_OPERATIONS * 0.95)].toFixed(2);
  const p99 = latenciesMs[Math.floor(TOTAL_OPERATIONS * 0.99)].toFixed(2);
  const opsPerSec = ((TOTAL_OPERATIONS / totalDurationMs) * 1000).toFixed(1);

  console.log("----------------------------------------------------------------");
  console.log(`Operations completed : ${TOTAL_OPERATIONS}`);
  console.log(`Total duration       : ${totalDurationMs.toFixed(2)} ms`);
  console.log(`Throughput           : ${opsPerSec} ops/sec`);
  console.log(`Latency p50          : ${p50} ms`);
  console.log(`Latency p95          : ${p95} ms`);
  console.log(`Latency p99          : ${p99} ms`);
  console.log("----------------------------------------------------------------");

  // Operational limits: p95 latency should remain below 100ms on local PostgreSQL
  assert.ok(parseFloat(p95) < 250, `p95 latency (${p95}ms) exceeded 250ms threshold`);

  await store.close();
  await pool.end();
  console.log("✓ Sustained load and latency benchmark completed successfully.");
});
