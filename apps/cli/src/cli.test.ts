import test from "node:test";
import assert from "node:assert/strict";
import { inspectGit } from "./git.js";
import { loadLocalConfig, saveLocalConfig, getCtxConfigPath } from "./config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Git inspector reports repo state safely", () => {
  const git = inspectGit();
  assert.equal(typeof git.isGitRepo, "boolean");
  assert.ok(git.branch);
  assert.equal(typeof git.workingTree.clean, "boolean");
});

test("Config manager saves and loads .ctx/config.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-test-"));
  try {
    const config = {
      schema_version: 1,
      project_id: "test-uuid-1234",
      project_name: "test-project",
      api_base_url: "http://127.0.0.1:3000",
      default_branch: "main",
    };

    saveLocalConfig(config, tmpDir);
    const loaded = loadLocalConfig(tmpDir);
    assert.deepEqual(loaded, config);
    assert.ok(fs.existsSync(getCtxConfigPath(tmpDir)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
