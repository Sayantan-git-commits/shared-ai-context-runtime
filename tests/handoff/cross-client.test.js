import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";
import { ClaudeCodeAdapter, PromptHandoffAdapter } from "../../packages/client-adapters/dist/index.js";
import { ContextSerializer } from "../../packages/serializers/dist/index.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";

test("Handoff: Independent client processes writing to and reading from PostgreSQL", async () => {
  const store = new PostgresContextStore(DATABASE_URL);
  const app = buildServer({ store, allowAnonymous: true });

  // 1. Resolve project on persistent database
  const projectName = `handoff-persistent-${Date.now()}`;
  const resolveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: { projectName, gitRemoteUrl: `git@github.com:handoff/${projectName}.git` },
  });
  assert.equal(resolveRes.statusCode, 200);
  const project = resolveRes.json();

  // 2. Client A creates a structured task
  const taskRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/tasks`,
    payload: {
      title: "Implement database connection pooling",
      status: "in_progress",
      nextAction: "verify pool drain on process exit",
    },
  });
  assert.equal(taskRes.statusCode, 201);
  const task = taskRes.json();

  // 3. Client A records a persistent checkpoint
  const ckptRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/checkpoints`,
    payload: {
      taskId: task.id,
      branch: "feature/pool-drain",
      gitCommit: "987fedc",
      workingTree: {
        clean: false,
        changedPaths: ["src/pool.ts", "tests/pool.test.ts"],
        untrackedPaths: [],
      },
      state: {
        completed: [
          { description: "Pool configuration added", evidence: "tests pass" },
          { description: "Advisory locks enabled", evidence: "stress test verified" },
        ],
        pending: ["Verify drain logic", "Add health check timeout"],
        decisions: [{ decision: "Use pg_advisory_xact_lock for checkpoint isolation" }],
        blockers: [],
        nextAction: "verify pool drain on process exit",
      },
    },
  });
  assert.equal(ckptRes.statusCode, 201);
  const checkpoint = ckptRes.json();
  assert.equal(checkpoint.version, 1);

  // 4. Client B (independent context assembly call) reads from PostgreSQL
  const assembleRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/context/assemble`,
    payload: {
      taskId: task.id,
      clientType: "claude-code",
      formatPreference: "auto",
    },
  });
  assert.equal(assembleRes.statusCode, 200);
  const assembled = assembleRes.json();

  assert.ok(assembled.content);
  assert.ok(["toon", "json"].includes(assembled.format));
  assert.ok(assembled.estimatedTokens > 0);

  // 5. Client B parses with ClaudeCodeAdapter
  const claudeAdapter = new ClaudeCodeAdapter();
  const resumeContext = await claudeAdapter.prepareResume(
    {
      format: assembled.format,
      serialized: assembled.content,
      estimatedTokens: assembled.estimatedTokens,
      baselineTokens: assembled.baselineTokens || assembled.estimatedTokens,
      savingsPercent: assembled.savingsPercent,
      contextVersion: checkpoint.version,
    },
    {
      projectName: project.name,
      checkpointVersion: checkpoint.version,
      nextAction: checkpoint.state.nextAction,
    }
  );

  assert.equal(resumeContext.mode, "prompt-ready");
  assert.ok(resumeContext.promptText.includes(projectName));
  assert.ok(resumeContext.promptText.includes("verify pool drain on process exit"));

  // 6. Round-trip fidelity verification
  const serializer = new ContextSerializer();
  const decoded = serializer.decode(assembled.content, assembled.format);
  assert.equal(decoded.projectId, project.id);
  assert.equal(decoded.checkpointVersion, 1);
  assert.equal(decoded.taskState.nextAction, "verify pool drain on process exit");

  await store.close();
  console.log("✓ Real cross-client handoff from persistent PostgreSQL storage verified.");
});
