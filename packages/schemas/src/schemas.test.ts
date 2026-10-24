import test from "node:test";
import assert from "node:assert/strict";
import { CheckpointSchema, ContextPackageSchema } from "./index.js";

test("CheckpointSchema validates valid checkpoint", () => {
  const sample = {
    id: "a0000000-0000-0000-0000-000000000001",
    projectId: "b0000000-0000-0000-0000-000000000001",
    version: 1,
    branch: "main",
    gitCommit: "abc1234",
    workingTree: {
      clean: true,
      changedPaths: [],
      untrackedPaths: [],
    },
    state: {
      completed: [{ description: "Initial setup", timestamp: new Date().toISOString() }],
      pending: ["Implement auth"],
      decisions: [{ decision: "Use Postgres for storage" }],
      blockers: [],
      nextAction: "Write tests",
    },
    createdAt: new Date().toISOString(),
    validityStatus: "valid",
  };

  const parsed = CheckpointSchema.safeParse(sample);
  assert.equal(parsed.success, true);
});

test("ContextPackageSchema validates structure", () => {
  const pkg = {
    projectId: "b0000000-0000-0000-0000-000000000001",
    instructions: ["Follow coding standards"],
    facts: { techStack: "TypeScript" },
    decisions: [{ title: "Monorepo layout" }],
    taskState: { status: "in_progress" },
    recentEvents: [],
  };

  const parsed = ContextPackageSchema.safeParse(pkg);
  assert.equal(parsed.success, true);
});
