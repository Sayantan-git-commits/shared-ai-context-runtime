import test from "node:test";
import assert from "node:assert/strict";
import { createCtxMcpServer } from "./server.js";
import { buildServer, MemoryContextStore } from "@ctx/api";

test("MCP Server: initializes with all core tools registered", () => {
  const server = createCtxMcpServer();
  assert.ok(server);
  const tools = Object.keys((server as any)._registeredTools || {});
  assert.ok(tools.includes("ctx_project_resolve"));
  assert.ok(tools.includes("ctx_save_checkpoint"));
  assert.ok(tools.includes("ctx_assemble_context"));
  assert.ok(tools.includes("ctx_search_memory"));
});

test("MCP Server: enforces authentication when calling protected API routes", async () => {
  const store = new MemoryContextStore();
  const api = buildServer({
    store,
    authToken: "mcp-test-secret-token",
  });

  const address = await api.listen({ port: 0, host: "127.0.0.1" });

  try {
    // 1. Unauthenticated MCP client fails with 401
    const unauthMcp = createCtxMcpServer({
      apiBaseUrl: address,
      // no authToken provided
    });
    const resolveTool = (unauthMcp as any)._registeredTools["ctx_project_resolve"];
    const unauthResult = await resolveTool.handler({ projectName: "unauth-test" });

    assert.equal(unauthResult.isError, true);
    assert.ok(unauthResult.content[0].text.includes("401"), `Expected 401 error message, got: ${unauthResult.content[0].text}`);

    // 2. Invalid token MCP client fails with 401
    const invalidMcp = createCtxMcpServer({
      apiBaseUrl: address,
      authToken: "wrong-bearer-token",
    });
    const invalidResult = await (invalidMcp as any)._registeredTools["ctx_project_resolve"].handler({ projectName: "invalid-test" });
    assert.equal(invalidResult.isError, true);
    assert.ok(invalidResult.content[0].text.includes("401"), `Expected 401 error message, got: ${invalidResult.content[0].text}`);

    // 3. Authenticated MCP client with valid token succeeds
    const authMcp = createCtxMcpServer({
      apiBaseUrl: address,
      authToken: "mcp-test-secret-token",
    });
    const authResult = await (authMcp as any)._registeredTools["ctx_project_resolve"].handler({ projectName: "mcp-authed-proj" });
    assert.equal(authResult.isError, undefined);
    const parsed = JSON.parse(authResult.content[0].text);
    assert.equal(parsed.name, "mcp-authed-proj");
    assert.ok(parsed.id);

    // 4. Authenticated MCP client can save checkpoint
    const saveTool = (authMcp as any)._registeredTools["ctx_save_checkpoint"];
    const saveResult = await saveTool.handler({
      projectId: parsed.id,
      branch: "main",
      gitCommit: "abc1234",
      nextAction: "Continue implementation",
    });
    assert.equal(saveResult.isError, undefined);
    assert.ok(saveResult.content[0].text.includes("Checkpoint v1 recorded successfully"));

    // 5. Assemble context via MCP
    const assembleTool = (authMcp as any)._registeredTools["ctx_assemble_context"];
    const assembleResult = await assembleTool.handler({
      projectId: parsed.id,
      formatPreference: "toon",
      tokenBudget: 4000,
    });
    assert.equal(assembleResult.isError, undefined);
    assert.ok(assembleResult.content[0].text.includes("ASSEMBLED CONTEXT"));
  } finally {
    await api.close();
  }
});

test("MCP Server: workingTreeClean defaults to fail-closed (clean: false) when omitted or dirty", async () => {
  const store = new MemoryContextStore();
  const api = buildServer({ store, authToken: "mcp-git-token" });
  const address = await api.listen({ port: 0, host: "127.0.0.1" });

  try {
    const mcp = createCtxMcpServer({ apiBaseUrl: address, authToken: "mcp-git-token" });
    const resolveTool = (mcp as any)._registeredTools["ctx_project_resolve"];
    const projRes = await resolveTool.handler({ projectName: "git-clean-test" });
    const project = JSON.parse(projRes.content[0].text);

    const saveTool = (mcp as any)._registeredTools["ctx_save_checkpoint"];
    const getCheckpointTool = (mcp as any)._registeredTools["ctx_get_checkpoint"];

    // Case 1: workingTreeClean omitted -> must fail-closed to clean: false
    await saveTool.handler({
      projectId: project.id,
      branch: "main",
      nextAction: "Step 1",
    });
    const cp1Res = await getCheckpointTool.handler({ projectId: project.id, latestOnly: true });
    const cp1 = JSON.parse(cp1Res.content[0].text);
    assert.equal(cp1.workingTree.clean, false, "Omitted workingTreeClean must default to false (fail-closed)");

    // Case 2: workingTreeClean explicitly false -> clean: false
    await saveTool.handler({
      projectId: project.id,
      branch: "main",
      workingTreeClean: false,
      nextAction: "Step 2",
    });
    const cp2Res = await getCheckpointTool.handler({ projectId: project.id, latestOnly: true });
    const cp2 = JSON.parse(cp2Res.content[0].text);
    assert.equal(cp2.workingTree.clean, false);

    // Case 3: workingTreeClean true BUT changedPaths non-empty -> clean: false
    await saveTool.handler({
      projectId: project.id,
      branch: "main",
      workingTreeClean: true,
      changedPaths: ["src/index.ts"],
      nextAction: "Step 3",
    });
    const cp3Res = await getCheckpointTool.handler({ projectId: project.id, latestOnly: true });
    const cp3 = JSON.parse(cp3Res.content[0].text);
    assert.equal(cp3.workingTree.clean, false, "Dirty files must override workingTreeClean: true to false");

    // Case 4: workingTreeClean true AND changedPaths empty -> clean: true
    await saveTool.handler({
      projectId: project.id,
      branch: "main",
      workingTreeClean: true,
      changedPaths: [],
      nextAction: "Step 4",
    });
    const cp4Res = await getCheckpointTool.handler({ projectId: project.id, latestOnly: true });
    const cp4 = JSON.parse(cp4Res.content[0].text);
    assert.equal(cp4.workingTree.clean, true, "Verified clean working tree must be true");
  } finally {
    await api.close();
  }
});
