import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildServer } from "../../apps/api/dist/server.js";
import { PostgresContextStore } from "../../apps/api/dist/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const mcpServerScript = path.join(rootDir, "apps/mcp-server/dist/index.js");

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";
const TEST_TOKEN = "handoff_secret_token_123";

test("Handoff: Genuine multi-process handoff between standalone API and MCP child process", async () => {
  const store = new PostgresContextStore(DATABASE_URL);
  const api = buildServer({
    store,
    authToken: TEST_TOKEN,
  });

  const apiAddress = await api.listen({ port: 0, host: "127.0.0.1" });
  console.log(`Standalone API listening on ${apiAddress}`);

  const projectName = `process-handoff-${Date.now()}`;

  // 1. Writer client (Tool A) writes state via HTTP API to persistent PostgreSQL
  const resolveRes = await fetch(`${apiAddress}/v1/projects/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({
      projectName,
      gitRemoteUrl: `git@github.com:process-handoff/${projectName}.git`,
    }),
  });
  assert.equal(resolveRes.status, 200);
  const project = await resolveRes.json();

  const taskRes = await fetch(`${apiAddress}/v1/projects/${project.id}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({
      title: "Cross-Process Context Transfer Verification",
      status: "in_progress",
      nextAction: "verify mcp child process retrieves state",
    }),
  });
  assert.equal(taskRes.status, 201);
  const task = await taskRes.json();

  const ckptRes = await fetch(`${apiAddress}/v1/projects/${project.id}/checkpoints`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({
      taskId: task.id,
      branch: "feature/stdio-mcp-handoff",
      gitCommit: "fa9823c",
      workingTree: {
        clean: false,
        changedPaths: ["apps/mcp-server/src/server.ts"],
        untrackedPaths: [],
      },
      state: {
        completed: [
          { description: "Started standalone API process", evidence: "listening on dynamic port" },
          { description: "Wrote checkpoint from Writer Client A", evidence: "version 1 created in DB" },
        ],
        pending: ["Read state from Reader MCP Client B"],
        decisions: [{ decision: "Use StdioClientTransport for real subprocess communication" }],
        blockers: [],
        nextAction: "verify mcp child process retrieves state",
      },
    }),
  });
  assert.equal(ckptRes.status, 201);
  const checkpoint = await ckptRes.json();
  assert.equal(checkpoint.version, 1);

  // 2. Reader client (Tool B): Launch apps/mcp-server as a completely separate child process over STDIO
  console.log("Launching MCP server child process over stdio...");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerScript],
    env: {
      ...process.env,
      CTX_API_URL: apiAddress,
      CTX_AUTH_TOKEN: TEST_TOKEN,
    },
  });

  const mcpClient = new Client(
    { name: "test-reader-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await mcpClient.connect(transport);
    console.log("Connected to MCP child process via stdio.");

    // Query tools via MCP protocol
    const toolsResult = await mcpClient.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    assert.ok(toolNames.includes("ctx_assemble_context"), "MCP server must register ctx_assemble_context");

    // Tool B invokes ctx_assemble_context through MCP protocol
    const callResult = await mcpClient.callTool({
      name: "ctx_assemble_context",
      arguments: {
        projectId: project.id,
        taskId: task.id,
        formatPreference: "auto",
      },
    });

    console.log("callResult:", JSON.stringify(callResult, null, 2));
    assert.ok(!callResult.isError, "MCP tool call must not have isError=true");
    const responseText = callResult.content[0].text;
    assert.ok(responseText.includes("ASSEMBLED CONTEXT"), "Must contain context header");
    assert.ok(
      responseText.includes("verify mcp child process retrieves state"),
      "Assembled context must contain exact nextAction persisted by Tool A"
    );
    assert.ok(
      responseText.includes("Started standalone API process"),
      "Assembled context must contain completed task history from PostgreSQL"
    );
    console.log("✓ Real cross-process handoff via MCP stdio client passed.");
  } finally {
    await mcpClient.close().catch(() => {});
    await api.close();
    await store.close();
  }
});
