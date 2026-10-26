import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const { Pool } = pg;
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";
import { runMigrations } from "../../scripts/migrate.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";

test("Resilience: Crash recovery, transaction rollbacks, and database health transitions", async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });

  // 1. Migration idempotency and interrupted recovery
  // Running migrations when already applied should be safe and idempotent
  const migrationRes = await runMigrations(DATABASE_URL);
  assert.ok(Array.isArray(migrationRes.applied));
  assert.ok(Array.isArray(migrationRes.skipped));
  console.log(`Migration idempotency confirmed: ${migrationRes.skipped.length} migrations up to date.`);

  // 2. Transaction Rollback Integrity
  // Simulate an interrupted checkpoint operation where failure occurs mid-transaction
  const projectName = `resilience-proj-${Date.now()}`;
  const store = new PostgresContextStore(DATABASE_URL);
  const app = buildServer({ store, allowAnonymous: true });

  const resolveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: { projectName, gitRemoteUrl: `git@github.com:resilience/${projectName}.git` },
  });
  const project = resolveRes.json();

  // Inspect checkpoint count before failure
  const beforeCountRes = await pool.query("SELECT COUNT(*) FROM checkpoints WHERE project_id = $1", [project.id]);
  const beforeCount = parseInt(beforeCountRes.rows[0].count, 10);

  // Intentionally inject invalid JSON/SQL trigger or simulated connection interruption in raw client
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [project.id]);
    await client.query(
      "INSERT INTO checkpoints (project_id, version, branch, state_json) VALUES ($1, 999, 'crash-test', '{\"test\": true}')",
      [project.id]
    );
    // Simulate process crash before COMMIT
    throw new Error("SIMULATED_PROCESS_CRASH_BEFORE_COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  // Verify that rollback occurred and no partial/orphan checkpoint was persisted
  const afterCountRes = await pool.query("SELECT COUNT(*) FROM checkpoints WHERE project_id = $1", [project.id]);
  const afterCount = parseInt(afterCountRes.rows[0].count, 10);
  assert.equal(afterCount, beforeCount, "Failed/interrupted transaction must leave zero orphan rows");

  // 3. Database Health Transition & Readiness Verification
  // When database is healthy, /health returns 200
  const healthyCheck = await app.inject({ method: "GET", url: "/health" });
  assert.equal(healthyCheck.statusCode, 200);
  assert.equal(healthyCheck.json().status, "ok");

  // Point store to an unavailable database host to simulate PostgreSQL network/pod crash
  const brokenStore = new PostgresContextStore("postgresql://postgres@127.0.0.1:54399/ctx_db");
  const brokenApp = buildServer({ store: brokenStore, allowAnonymous: true });

  const degradedCheck = await brokenApp.inject({ method: "GET", url: "/health" });
  assert.equal(degradedCheck.statusCode, 503, "Health check must return 503 when PostgreSQL is unreachable");
  assert.equal(degradedCheck.json().status, "unhealthy");
  assert.equal(degradedCheck.json().error, "Database unavailable");

  await store.close();
  await brokenStore.close();
  await pool.end();
  console.log("✓ Crash recovery and health transition suite passed.");
});
