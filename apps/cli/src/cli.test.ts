import test from "node:test";
import assert from "node:assert/strict";
import { inspectGit, redactSecrets, isSensitivePath, GIT_PATHSPEC_EXCLUSIONS } from "./git.js";
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

test("Git: redactSecrets sanitizes database connection URLs and JWT tokens", () => {
  const diffWithDbAndJwt = `
+DATABASE_URL="postgresql://ctx_admin:SuperSecretDbPassword99@cluster.internal:5432/production_db"
+URL_ENCODED_DB="postgresql://app_user:p%40ss%3Aword%21%2399@cluster.internal:5432/production_db"
+AMQP_URL="amqp://guest:P@ssword!@broker.internal:5672/"
+USER_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
+BASIC_AUTH="Authorization: Basic dXNlcjpwYXNzd29yZA=="
+CTX_SECRET="ctx_sec_abcdef1234567890"
+GITHUB_FINE_GRAINED="github_pat_11ABCDE_12345678901234567890123456789012345678901234567890"
+-----BEGIN PGP PRIVATE KEY BLOCK-----
+Version: GnuPG v2
+lQOYBF2X...
+=xyz1
+-----END PGP PRIVATE KEY BLOCK-----
`;

  const redacted = redactSecrets(diffWithDbAndJwt);
  assert.ok(!redacted.includes("SuperSecretDbPassword99"), "Database password in connection URL must be redacted");
  assert.ok(!redacted.includes("p%40ss%3Aword%21%2399"), "URL-encoded database password must be redacted");
  assert.ok(!redacted.includes("P@ssword!"), "Broker password in connection URL must be redacted");
  assert.ok(!redacted.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), "JWT signature must be redacted");
  assert.ok(!redacted.includes("dXNlcjpwYXNzd29yZA=="), "Basic auth credentials must be redacted");
  assert.ok(!redacted.includes("ctx_sec_abcdef1234567890"), "CTX token must be redacted");
  assert.ok(!redacted.includes("github_pat_11ABCDE"), "Fine-grained PAT must be redacted");
  assert.ok(!redacted.includes("lQOYBF2X"), "PGP private key block must be redacted");
  assert.ok(redacted.includes("postgresql://ctx_admin:[REDACTED]@cluster.internal:5432/production_db"));
  assert.ok(redacted.includes("postgresql://app_user:[REDACTED]@cluster.internal:5432/production_db"));
  assert.ok(redacted.includes("[REDACTED JWT]"));
  assert.ok(redacted.includes("[REDACTED CTX TOKEN]"));
  assert.ok(redacted.includes("[REDACTED GITHUB TOKEN]"));
  assert.ok(redacted.includes("[REDACTED PRIVATE KEY]"));
});

test("Git: isSensitivePath identifies files that must never have diff contents captured", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath(".env.production"), true);
  assert.equal(isSensitivePath("config/credentials.json"), true);
  assert.equal(isSensitivePath("certs/server.key"), true);
  assert.equal(isSensitivePath("certs/cert.pem"), true);
  assert.equal(isSensitivePath("keys/id_rsa"), true);
  assert.equal(isSensitivePath("keys/id_ed25519"), true);
  assert.equal(isSensitivePath(".kube/kubeconfig"), true);
  assert.equal(isSensitivePath("auth/service-account-key.json"), true);

  // Non-sensitive files must pass
  assert.equal(isSensitivePath("src/index.ts"), false);
  assert.equal(isSensitivePath("README.md"), false);
  assert.equal(isSensitivePath("package.json"), false);
  assert.equal(isSensitivePath("Dockerfile"), false);
});

test("Git: GIT_PATHSPEC_EXCLUSIONS aligns with sensitive path patterns", () => {
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.env"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*credentials*"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.pem"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.key"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.pkcs12"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.pfx"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*.keystore"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*id_rsa*"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*id_ed25519*"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*id_ecdsa*"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*kubeconfig*"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*service-account*.json"));
  assert.ok(GIT_PATHSPEC_EXCLUSIONS.includes(":(exclude)*secret*.json"));
});
