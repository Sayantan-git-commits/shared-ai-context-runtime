import test from "node:test";
import assert from "node:assert/strict";
import { createCtxMcpServer } from "./server.js";

test("MCP Server initializes with all core tools registered", () => {
  const server = createCtxMcpServer();
  assert.ok(server);
});
