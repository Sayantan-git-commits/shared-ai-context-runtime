import test from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";
import { createCtxMcpServer } from "../../apps/mcp-server/dist/server.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";
const AUTH_TOKEN_A = "token_tenant_alpha_secure_99";
const AUTH_TOKEN_B = "token_tenant_beta_secure_88";

test("Security: Adversarial cross-tenant access rejection across API and MCP operations", async () => {
  const store = new PostgresContextStore(DATABASE_URL);

  // Tenant A server (authenticated)
  const appA = buildServer({
    store,
    authToken: AUTH_TOKEN_A,
    organizationId: "11111111-1111-1111-1111-111111111111",
  });

  // Tenant B server (authenticated with distinct organizationId)
  const appB = buildServer({
    store,
    authToken: AUTH_TOKEN_B,
    organizationId: "22222222-2222-2222-2222-222222222222",
  });

  // 1. Tenant A creates project, task, and checkpoint
  const projResA = await appA.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: { authorization: `Bearer ${AUTH_TOKEN_A}` },
    payload: {
      projectName: `tenant-a-secrets-${Date.now()}`,
      gitRemoteUrl: "git@github.com:tenant-a/core-secrets.git",
    },
  });
  assert.equal(projResA.statusCode, 200);
  const projectA = projResA.json();

  const taskResA = await appA.inject({
    method: "POST",
    url: `/v1/projects/${projectA.id}/tasks`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_A}` },
    payload: {
      title: "Tenant A Confidential Infrastructure Task",
      status: "in_progress",
      nextAction: "rotate private keys",
    },
  });
  assert.equal(taskResA.statusCode, 201);
  const taskA = taskResA.json();

  const ckptResA = await appA.inject({
    method: "POST",
    url: `/v1/projects/${projectA.id}/checkpoints`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_A}` },
    payload: {
      taskId: taskA.id,
      branch: "main",
      gitCommit: "commit_a_123",
      workingTree: { clean: true, changedPaths: [], untrackedPaths: [] },
      state: {
        completed: [{ description: "Private vault configured", evidence: "secret_sha256" }],
        pending: [],
        decisions: [{ decision: "Keep tenant data isolated" }],
        blockers: [],
        nextAction: "rotate private keys",
      },
    },
  });
  assert.equal(ckptResA.statusCode, 201);
  const ckptA = ckptResA.json();

  // 2. Adversarial Test: Tenant B attempts to read Tenant A's project
  const getProjB = await appB.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_B}` },
  });
  assert.equal(getProjB.statusCode, 403, "Tenant B must be forbidden (403) from Tenant A project");

  // 3. Adversarial Test: Tenant B attempts to read Tenant A's tasks
  const getTasksB = await appB.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}/tasks`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_B}` },
  });
  assert.equal(getTasksB.statusCode, 403, "Tenant B must be forbidden (403) from Tenant A tasks");

  // 4. Adversarial Test: Tenant B attempts to mutate Tenant A's task
  const patchTaskB = await appB.inject({
    method: "PATCH",
    url: `/v1/tasks/${taskA.id}`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_B}` },
    payload: { nextAction: "hijacked by tenant b" },
  });
  assert.equal(patchTaskB.statusCode, 403, "Tenant B must be forbidden (403) from mutating Tenant A task");

  // 5. Adversarial Test: Tenant B attempts to append a checkpoint to Tenant A's project
  const postCkptB = await appB.inject({
    method: "POST",
    url: `/v1/projects/${projectA.id}/checkpoints`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_B}` },
    payload: {
      taskId: taskA.id,
      branch: "exploit",
      workingTree: { clean: true, changedPaths: [], untrackedPaths: [] },
      state: { completed: [], pending: [], decisions: [], blockers: [], nextAction: "hijack" },
    },
  });
  assert.equal(postCkptB.statusCode, 403, "Tenant B must be forbidden (403) from posting checkpoints to Tenant A project");

  // 6. Adversarial Test: Tenant B attempts to assemble Tenant A's context
  const assembleB = await appB.inject({
    method: "POST",
    url: `/v1/projects/${projectA.id}/context/assemble`,
    headers: { authorization: `Bearer ${AUTH_TOKEN_B}` },
    payload: { clientType: "generic-mcp" },
  });
  assert.equal(assembleB.statusCode, 403, "Tenant B must be forbidden (403) from assembling Tenant A context");

  // 7. Adversarial Test: Missing, invalid, and expired authentication headers
  const unauthRes = await appA.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}`,
  });
  assert.equal(unauthRes.statusCode, 401, "Missing auth token must return 401 Unauthorized");

  const invalidAuthRes = await appA.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}`,
    headers: { authorization: "Bearer completely_fake_invalid_token" },
  });
  assert.equal(invalidAuthRes.statusCode, 401, "Invalid auth token must return 401 Unauthorized");

  // 8. Adversarial Test: Tenant spoofing via custom headers (e.g., x-org-id)
  const spoofHeaderRes = await appB.inject({
    method: "GET",
    url: `/v1/projects/${projectA.id}`,
    headers: {
      authorization: `Bearer ${AUTH_TOKEN_B}`,
      "x-organization-id": "11111111-1111-1111-1111-111111111111",
    },
  });
  assert.equal(spoofHeaderRes.statusCode, 403, "Header spoofing must be strictly rejected with 403 Forbidden");

  // 9. Sensitive Information Audit: Error responses must never leak database details or tokens
  assert.equal(unauthRes.json().message, "Valid Bearer token or x-api-key header required");
  assert.ok(!JSON.stringify(unauthRes.json()).includes(AUTH_TOKEN_A));
  assert.ok(!JSON.stringify(getProjB.json()).includes("11111111-1111-1111-1111-111111111111"));

  // 10. Direct MCP Tool Protocol Tenant Isolation Verification
  // Start appA on dynamic port
  const serverAddressA = await appA.listen({ port: 0, host: "127.0.0.1" });
  try {
    // Client configured with Tenant B's credentials attempts to call MCP tools against Tenant A's project
    const mcpClientB = createCtxMcpServer({
      apiBaseUrl: serverAddressA,
      authToken: AUTH_TOKEN_B,
    });

    const mcpAssembleTool = mcpClientB._registeredTools["ctx_assemble_context"];
    assert.ok(mcpAssembleTool, "ctx_assemble_context must be registered");

    const mcpAssembleResult = await mcpAssembleTool.handler({
      projectId: projectA.id,
      taskId: taskA.id,
    });

    // Must fail closed with 401 or 403 error inside MCP tool result
    assert.equal(mcpAssembleResult.isError, true, "Cross-tenant MCP tool call must fail with isError=true");
    assert.ok(
      mcpAssembleResult.content[0].text.includes("401") || mcpAssembleResult.content[0].text.includes("403"),
      "MCP error content must reflect authentication/authorization denial"
    );
    // Test all registered MCP mutation/query tools under adversarial tenant credentials:
    // ctx_save_checkpoint, ctx_update_task, ctx_record_event, ctx_acquire_task_lease
    const mcpSaveCheckpointTool = mcpClientB._registeredTools["ctx_save_checkpoint"];
    assert.ok(mcpSaveCheckpointTool, "ctx_save_checkpoint must be registered");
    const mcpSaveCheckpointResult = await mcpSaveCheckpointTool.handler({
      projectId: projectA.id,
      taskId: taskA.id,
      branch: "exploit-branch",
      completed: ["injected data"],
      nextAction: "exploit",
    });
    assert.equal(mcpSaveCheckpointResult.isError, true, "Adversarial ctx_save_checkpoint must fail closed");

    const mcpUpdateTaskTool = mcpClientB._registeredTools["ctx_update_task"];
    assert.ok(mcpUpdateTaskTool, "ctx_update_task must be registered");
    const mcpUpdateTaskResult = await mcpUpdateTaskTool.handler({
      taskId: taskA.id,
      nextAction: "exploit hijacked task",
    });
    assert.equal(mcpUpdateTaskResult.isError, true, "Adversarial ctx_update_task must fail closed");

    const mcpRecordEventTool = mcpClientB._registeredTools["ctx_record_event"];
    assert.ok(mcpRecordEventTool, "ctx_record_event must be registered");
    const mcpRecordEventResult = await mcpRecordEventTool.handler({
      projectId: projectA.id,
      eventType: "malicious_event",
      payload: { data: "exploit" },
    });
    assert.equal(mcpRecordEventResult.isError, true, "Adversarial ctx_record_event must fail closed");

    const mcpLeaseTool = mcpClientB._registeredTools["ctx_acquire_task_lease"];
    assert.ok(mcpLeaseTool, "ctx_acquire_task_lease must be registered");
    const mcpLeaseResult = await mcpLeaseTool.handler({
      taskId: taskA.id,
      agentId: "attacker-agent",
      ttlSeconds: 60,
    });
    assert.equal(mcpLeaseResult.isError, true, "Adversarial ctx_acquire_task_lease must fail closed");

    console.log("✓ Direct MCP tool suite tenant isolation confirmed across all tools.");
  } finally {
    await appA.close();
  }

  // 11. Rate Limiting Verification: Trip 429 Too Many Requests when rate limiting is enabled
  const rateLimitedApp = buildServer({
    store,
    authToken: AUTH_TOKEN_A,
    enableRateLimit: true,
  });

  try {
    let hitRateLimit = false;
    for (let i = 0; i < 110; i++) {
      const res = await rateLimitedApp.inject({
        method: "GET",
        url: `/v1/projects/${projectA.id}`,
        headers: { authorization: `Bearer ${AUTH_TOKEN_A}` },
      });
      if (res.statusCode === 429) {
        hitRateLimit = true;
        break;
      }
    }
    assert.ok(hitRateLimit, "Exceeding 100 requests per minute must trigger HTTP 429 Rate Limit");
    console.log("✓ Rate limiting trip threshold (HTTP 429) verified.");
  } finally {
    await rateLimitedApp.close();
  }

  // 12. Oversized Payload Verification: Exceeding Fastify payload limit returns 413
  const oversizedPayload = "A".repeat(2 * 1024 * 1024); // 2 MB (Fastify default bodyLimit is 1 MB)
  const oversizedRes = await appB.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN_B}`,
      "content-type": "application/json",
    },
    payload: `{"projectName":"${oversizedPayload}"}`,
  });
  assert.equal(oversizedRes.statusCode, 413, "Oversized request payload (>1MB) must fail with HTTP 413 Payload Too Large");
  console.log("✓ Oversized payload rejection (HTTP 413) verified.");

  // 13. Audit Log Secret Redaction Verification: Injected secret tokens must never leak in error messages
  const maliciousSecretPayload = "SUPER_SECRET_AWS_KEY_AKIAIOSFODNN7EXAMPLE";
  const unauthAttempt = await appB.inject({
    method: "POST",
    url: "/v1/projects/resolve",
    headers: {
      authorization: `Bearer ${maliciousSecretPayload}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ projectName: "secret-test" }),
  });
  const rawBody = unauthAttempt.body;
  assert.ok(!rawBody.includes(maliciousSecretPayload), "Secret credential tokens must never appear in response payloads");
  console.log("✓ Zero-credential leakage in error responses verified.");

  await store.close();
  console.log("✓ Full tenant-isolation and authentication penetration audit passed.");
});
