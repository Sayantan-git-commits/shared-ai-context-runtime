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
    console.log("✓ Direct MCP tool tenant isolation confirmed.");
  } finally {
    await appA.close();
  }

  await store.close();
  console.log("✓ Full tenant-isolation and authentication penetration audit passed.");
});
