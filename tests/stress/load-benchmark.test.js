import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";

test("Load & Performance: Concurrent HTTP network load benchmark across multiple projects and tasks", async () => {
  const store = new PostgresContextStore(DATABASE_URL);
  const app = buildServer({ store, allowAnonymous: true });
  const pool = new Pool({ connectionString: DATABASE_URL });

  // Start HTTP server on dynamic port for genuine concurrent network requests
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  console.log(`Load benchmark target listening at: ${address}`);

  // 1. Setup multiple projects and tasks to simulate multi-tenant concurrent traffic
  const PROJECT_COUNT = 5;
  const projectFixtures = [];

  for (let p = 0; p < PROJECT_COUNT; p++) {
    const projName = `perf-tenant-project-${p + 1}-${Date.now()}`;
    const pRes = await fetch(`${address}/v1/projects/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName: projName,
        gitRemoteUrl: `git@github.com:load/${projName}.git`,
      }),
    });
    assert.equal(pRes.status, 200);
    const proj = await pRes.json();

    const tRes = await fetch(`${address}/v1/projects/${proj.id}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Concurrent task load for project ${p + 1}`,
        status: "in_progress",
        nextAction: "execute concurrent benchmark queries",
      }),
    });
    assert.equal(tRes.status, 201);
    const task = await tRes.json();

    projectFixtures.push({ project: proj, task });
  }

  // 2. Execute concurrent HTTP request pool (mixed reads and writes)
  const CONCURRENCY_LEVEL = 10;
  const OPERATIONS_PER_WORKER = 15;
  const TOTAL_OPERATIONS = CONCURRENCY_LEVEL * OPERATIONS_PER_WORKER;

  console.log(`\nStarting concurrent HTTP load test:`);
  console.log(`- Total Requests  : ${TOTAL_OPERATIONS}`);
  console.log(`- Concurrent Pool : ${CONCURRENCY_LEVEL} workers`);
  console.log(`- Target Projects : ${PROJECT_COUNT}`);
  console.log(`- Workload Mix    : 50% Writes (/checkpoints), 50% Reads (/context/assemble)`);

  const latenciesMs = [];
  const errors = [];
  const tStart = performance.now();

  const workerPromises = Array.from({ length: CONCURRENCY_LEVEL }, async (_, workerId) => {
    for (let op = 0; op < OPERATIONS_PER_WORKER; op++) {
      const fixture = projectFixtures[(workerId + op) % PROJECT_COUNT];
      const isWrite = (workerId + op) % 2 === 0;
      const tOpStart = performance.now();

      try {
        if (isWrite) {
          const res = await fetch(`${address}/v1/projects/${fixture.project.id}/checkpoints`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskId: fixture.task.id,
              branch: "feature/load-test",
              gitCommit: `commit_w${workerId}_op${op}`,
              workingTree: { clean: true, changedPaths: [], untrackedPaths: [] },
              state: {
                completed: [{ description: `Worker ${workerId} Op ${op}`, evidence: "ok" }],
                pending: [],
                decisions: [],
                blockers: [],
                nextAction: "continue load generation",
              },
            }),
          });
          if (res.status !== 201) {
            errors.push({ status: res.status, op: "write", workerId });
          }
        } else {
          const res = await fetch(`${address}/v1/projects/${fixture.project.id}/context/assemble`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskId: fixture.task.id,
              clientType: "generic-mcp",
              formatPreference: "auto",
            }),
          });
          if (res.status !== 200) {
            errors.push({ status: res.status, op: "read", workerId });
          }
        }
      } catch (err) {
        errors.push({ error: err.message, workerId });
      }

      latenciesMs.push(performance.now() - tOpStart);
    }
  });

  await Promise.all(workerPromises);
  const totalElapsedMs = performance.now() - tStart;

  // 3. Measure Database Connection Pool Saturation
  const poolCheck = await pool.query(`
    SELECT count(*) AS total_connections,
           count(*) FILTER (WHERE state = 'active') AS active_connections
    FROM pg_stat_activity
    WHERE datname = 'ctx_db'
  `);
  const totalDbConns = poolCheck.rows[0].total_connections;
  const activeDbConns = poolCheck.rows[0].active_connections;

  // 4. Compute Statistical Latency Distribution
  latenciesMs.sort((a, b) => a - b);
  const p50 = latenciesMs[Math.floor(latenciesMs.length * 0.5)].toFixed(2);
  const p95 = latenciesMs[Math.floor(latenciesMs.length * 0.95)].toFixed(2);
  const p99 = latenciesMs[Math.floor(latenciesMs.length * 0.99)].toFixed(2);
  const minLatency = latenciesMs[0].toFixed(2);
  const maxLatency = latenciesMs[latenciesMs.length - 1].toFixed(2);
  const throughput = ((TOTAL_OPERATIONS / totalElapsedMs) * 1000).toFixed(1);
  const errorRatePercent = ((errors.length / TOTAL_OPERATIONS) * 100).toFixed(2);

  console.log("\n================ CONCURRENT LOAD BENCHMARK REPORT ================");
  console.log(`Total Operations Executed  : ${TOTAL_OPERATIONS}`);
  console.log(`Successful Requests        : ${TOTAL_OPERATIONS - errors.length}`);
  console.log(`Failed Requests / Errors   : ${errors.length} (${errorRatePercent}%)`);
  console.log(`Total Duration             : ${totalElapsedMs.toFixed(2)} ms`);
  console.log(`Concurrent Network Ops/sec : ${throughput} req/sec`);
  console.log(`Latency Min                : ${minLatency} ms`);
  console.log(`Latency p50 (Median)       : ${p50} ms`);
  console.log(`Latency p95                : ${p95} ms`);
  console.log(`Latency p99                : ${p99} ms`);
  console.log(`Latency Max                : ${maxLatency} ms`);
  console.log(`PostgreSQL Active Conns    : ${activeDbConns} / ${totalDbConns} total`);
  console.log("==================================================================\n");

  // Performance & Resilience Gates
  assert.equal(errors.length, 0, `Expected 0 failed operations, got: ${JSON.stringify(errors)}`);
  assert.ok(parseFloat(p95) < 300, `p95 latency (${p95}ms) exceeded 300ms SLA target`);

  await app.close();
  await store.close();
  await pool.end();
  console.log("✓ Concurrent HTTP load test passed all SLA thresholds.");
});
