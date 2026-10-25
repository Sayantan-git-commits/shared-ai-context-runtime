import test from "node:test";
import assert from "node:assert/strict";
import { inspectGit, redactSecrets } from "./git.js";
import { loadLocalConfig, saveLocalConfig, getCtxConfigPath } from "./config.js";
import { normalizeArgv } from "./argv.js";
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

test("CLI: normalizeArgv supports path-first syntax 'ctx <path> continue'", () => {
  // 1. ctx /path/to/project continue --budget 4000
  const input1 = ["node", "ctx", "/path/to/project", "continue", "--budget", "4000"];
  const expected1 = ["node", "ctx", "continue", "/path/to/project", "--budget", "4000"];
  assert.deepEqual(normalizeArgv(input1), expected1);

  // 2. ctx ./subfolder status
  const input2 = ["node", "ctx", "./subfolder", "status"];
  const expected2 = ["node", "ctx", "status", "./subfolder"];
  assert.deepEqual(normalizeArgv(input2), expected2);

  // 3. ctx . continue
  const input3 = ["node", "ctx", ".", "continue"];
  const expected3 = ["node", "ctx", "continue", "."];
  assert.deepEqual(normalizeArgv(input3), expected3);

  // 4. Standard command-first remains unchanged: ctx continue /path/to/project
  const standard = ["node", "ctx", "continue", "/path/to/project"];
  assert.deepEqual(normalizeArgv(standard), standard);
});

test("Git: redactSecrets masks sensitive credentials and API keys in diffs", () => {
  const sampleDiff = `
diff --git a/config.env b/config.env
+OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890
+GITHUB_TOKEN=ghp_123456789012345678901234567890123456
+AWS_KEY=AKIAIOSFODNN7EXAMPLE
+AUTH_HEADER="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz"
+DB_PASSWORD="SuperSecretPassword123"
+NORMAL_VALUE="hello-world"
+-----BEGIN RSA PRIVATE KEY-----
+MIIEowIBAAKCAQEA0Y123456789...
+-----END RSA PRIVATE KEY-----
`;

  const redacted = redactSecrets(sampleDiff);
  assert.ok(!redacted.includes("sk-abcdef1234567890abcdef1234567890"), "OpenAI key should be redacted");
  assert.ok(!redacted.includes("ghp_123456789012345678901234567890123456"), "GitHub token should be redacted");
  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"), "AWS key should be redacted");
  assert.ok(!redacted.includes("SuperSecretPassword123"), "Password should be redacted");
  assert.ok(!redacted.includes("MIIEowIBAAKCAQEA0Y123456789"), "Private key block should be redacted");
  assert.ok(redacted.includes("NORMAL_VALUE=\"hello-world\""), "Non-secret values should be preserved");
  assert.ok(redacted.includes("[REDACTED API KEY]"));
  assert.ok(redacted.includes("[REDACTED GITHUB TOKEN]"));
  assert.ok(redacted.includes("[REDACTED AWS ACCESS KEY]"));
  assert.ok(redacted.includes("[REDACTED PRIVATE KEY]"));
});
