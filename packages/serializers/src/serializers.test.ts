import test from "node:test";
import assert from "node:assert/strict";
import { ContextSerializer } from "./index.js";
import type { ContextPackage } from "@ctx/schemas";

test("ContextSerializer encodes and round-trips TOON & JSON", async () => {
  const serializer = new ContextSerializer();

  const samplePackage: ContextPackage = {
    schemaVersion: 1,
    projectId: "b0000000-0000-0000-0000-000000000001",
    projectName: "auth-service",
    taskId: "c0000000-0000-0000-0000-000000000001",
    checkpointVersion: 3,
    instructions: [
      "Follow project coding standards",
      "Do not leave uncommitted changes without a checkpoint",
    ],
    facts: {
      authStrategy: "JWT + Rotating Refresh Tokens",
      database: "PostgreSQL",
      tokenExpiry: "15m",
    },
    decisions: [
      { id: "dec-1", decision: "Store refresh tokens in hashed format", status: "accepted" },
      { id: "dec-2", decision: "Enforce 1-active-session policy per device", status: "accepted" },
    ],
    taskState: {
      title: "Implement refresh-token rotation",
      status: "in_progress",
      completed: ["JWT verification middleware", "POST /auth/refresh endpoint"],
      pending: ["Write integration test for token reuse detection"],
      nextAction: "Inspect the failing token rotation test",
    },
    recentEvents: [
      { type: "test_run", outcome: "failed", target: "tests/auth_rotation.test.ts" },
    ],
  };

  const result = await serializer.encode(samplePackage, "auto");
  assert.ok(result.serialized.length > 0);
  assert.ok(["toon", "json"].includes(result.format));
  assert.ok(result.baselineTokens > 0);
  assert.ok(result.estimatedTokens > 0);

  // Test decoding
  const decoded = serializer.decode(result.serialized, result.format) as any;
  assert.equal(decoded.projectId, samplePackage.projectId);
  assert.equal(decoded.projectName, samplePackage.projectName);
});

test("ContextSerializer enforces tokenBudget pruning on large context", async () => {
  const serializer = new ContextSerializer();

  const largePackage: ContextPackage = {
    schemaVersion: 1,
    projectId: "b0000000-0000-0000-0000-000000000001",
    projectName: "huge-service",
    instructions: ["System instruction 1", "System instruction 2"],
    facts: {
      fact1: "value1",
      fact2: "value2",
      fact3: "value3",
      fact4: "value4",
      fact5: "value5",
      fact6: "value6",
      fact7: "value7",
    },
    decisions: [
      { id: "1", title: "dec 1" },
      { id: "2", title: "dec 2" },
      { id: "3", title: "dec 3" },
      { id: "4", title: "dec 4" },
      { id: "5", title: "dec 5" },
    ],
    taskState: {
      title: "Active task",
      status: "in_progress",
      nextAction: "Crucial next step",
      completed: [
        { description: "step 1", evidence: "large log dump of 100 lines..." },
        { description: "step 2", evidence: "another large log dump..." },
      ],
      pending: [],
    },
    recentEvents: [
      { event: "log1", detail: "very verbose output" },
      { event: "log2", detail: "even more verbose" },
      { event: "log3", detail: "lots of tokens" },
    ],
  };

  // Restrict to tight budget: 150 tokens
  const result = await serializer.encode(largePackage, "auto", 150);
  assert.ok(result.prunedItemsCount > 0);

  // Essential state must be preserved
  const decoded = serializer.decode(result.serialized, result.format) as any;
  assert.equal(decoded.taskState.nextAction, "Crucial next step");
  assert.equal(decoded.projectName, "huge-service");
});
