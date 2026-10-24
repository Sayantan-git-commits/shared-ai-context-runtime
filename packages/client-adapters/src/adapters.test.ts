import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, PromptHandoffAdapter } from "./index.js";

test("AdapterRegistry resolves fallback adapter", async () => {
  const registry = new AdapterRegistry();
  const adapter = await registry.getAdapter();
  assert.ok(adapter);

  const res = await adapter.prepareResume({
    format: "toon",
    serialized: "task: sample",
    estimatedTokens: 25,
    baselineTokens: 35,
    savingsPercent: 28.57,
    contextVersion: 1,
  });

  assert.equal(res.mode, "prompt-ready");
  assert.ok(res.promptText.includes("RESUMING PROJECT TASK CONTEXT"));
});
