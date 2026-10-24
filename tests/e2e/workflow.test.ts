import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../apps/api/dist/server.js";
import { ContextSerializer } from "../../packages/serializers/dist/index.js";
import {
  AdapterRegistry,
  ClaudeCodeAdapter,
  PromptHandoffAdapter,
} from "../../packages/client-adapters/dist/index.js";
import type { ContextPackage } from "../../packages/schemas/dist/index.js";

test("E2E: Full cross-client handoff workflow (Tool A -> Tool B)", async () => {
  const app = buildServer();

  // 1. Resolve project
  const resolveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    payload: {
      projectName: "shared-auth-service",
      gitRemoteUrl: "git@github.com:asrax/shared-auth.git",
    },
  });
  assert.equal(resolveRes.statusCode, 200);
  const project = resolveRes.json();

  // 2. Client A creates a task
  const taskRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/tasks`,
    payload: {
      title: "Implement refresh-token rotation",
      status: "in_progress",
      nextAction: "inspect the failing token rotation test",
    },
  });
  assert.equal(taskRes.statusCode, 201);
  const task = taskRes.json();

  // 3. Client A records a checkpoint (version 1)
  const ckptRes = await app.inject({
    method: "POST",
    url: `/v1/projects/${project.id}/checkpoints`,
    payload: {
      taskId: task.id,
      branch: "feature/auth-refresh",
      gitCommit: "abc1234",
      workingTree: {
        clean: false,
        changedPaths: ["src/auth/refresh.py", "tests/test_refresh_tokens.py"],
        untrackedPaths: [],
      },
      state: {
        completed: [
          { description: "JWT authentication implemented", evidence: "test_auth passed" },
          { description: "Refresh-token endpoint created", evidence: "POST /refresh returned 200" },
        ],
        pending: ["Fix token rotation tests", "Run regression suite"],
        decisions: [{ decision: "Use rotating refresh tokens" }],
        blockers: [],
        nextAction: "inspect the failing token rotation test",
      },
    },
  });
  assert.equal(ckptRes.statusCode, 201);
  const checkpoint = ckptRes.json();
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.branch, "feature/auth-refresh");

  // 4. Client B switches in and calls context assembly
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

  // 5. Test Client B Adapter (ClaudeCodeAdapter)
  const claudeAdapter = new ClaudeCodeAdapter();
  const claudeResume = await claudeAdapter.prepareResume(
    {
      format: assembled.format,
      serialized: assembled.content,
      estimatedTokens: assembled.estimatedTokens,
      baselineTokens: assembled.baselineTokens || assembled.estimatedTokens,
      savingsPercent: assembled.savingsPercent,
      contextVersion: 1,
    },
    {
      projectName: project.name,
      checkpointVersion: checkpoint.version,
      nextAction: checkpoint.state.nextAction,
    }
  );

  assert.equal(claudeResume.mode, "prompt-ready");
  assert.ok(claudeResume.promptText.includes("shared-auth-service"));
  assert.ok(claudeResume.promptText.includes("inspect the failing token rotation test"));

  // 6. Test Client C Adapter (Generic PromptHandoffAdapter)
  const genericAdapter = new PromptHandoffAdapter();
  const genericResume = await genericAdapter.prepareResume(
    {
      format: assembled.format,
      serialized: assembled.content,
      estimatedTokens: assembled.estimatedTokens,
      baselineTokens: assembled.baselineTokens || assembled.estimatedTokens,
      savingsPercent: assembled.savingsPercent,
      contextVersion: 1,
    },
    {
      nextAction: checkpoint.state.nextAction,
    }
  );

  assert.equal(genericResume.mode, "prompt-ready");
  assert.ok(genericResume.promptText.includes("RESUMING PROJECT TASK CONTEXT"));
  assert.ok(genericResume.promptText.includes("inspect the failing token rotation test"));

  // 7. Verify TOON serialization efficiency and round-trip decoding
  const serializer = new ContextSerializer();
  const pkg: ContextPackage = {
    schemaVersion: 1,
    projectId: project.id,
    projectName: project.name,
    taskId: task.id,
    checkpointVersion: checkpoint.version,
    instructions: ["Follow coding standards"],
    facts: { auth: "JWT", db: "PostgreSQL" },
    decisions: [{ decision: "Use rotating refresh tokens" }],
    taskState: {
      completed: ["JWT authentication", "refresh endpoint"],
      pending: ["fix tests"],
      nextAction: "inspect failing test",
    },
    recentEvents: [],
  };

  const encoded = await serializer.encode(pkg, "auto");
  assert.ok(encoded.serialized.length > 0);
  const decoded = serializer.decode(encoded.serialized, encoded.format) as any;
  assert.equal(decoded.projectId, project.id);
});
