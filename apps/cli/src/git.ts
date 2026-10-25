import { execSync } from "node:child_process";
import type { WorkingTreeSummary } from "@ctx/schemas";

/**
 * Redacts common secrets, private keys, API keys, and authorization tokens
 * from diff patches before saving into context checkpoints.
 */
export function redactSecrets(diff: string): string {
  if (!diff) return diff;
  let out = diff;
  // 1. Private keys
  out = out.replace(/-----BEGIN [A-Z0-9_\s-]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_\s-]+PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
  // 2. Well-known API key formats
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, "[REDACTED GITHUB TOKEN]");
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
  // 3. Bearer tokens in headers or code
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}\b/gi, "$1[REDACTED]");
  // 4. Key/value assignments matching secret names where value was not already redacted
  out = out.replace(
    /(["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^"'\s\r\n]{6,})(["']?)/gi,
    "$1[REDACTED]$3"
  );
  return out;
}

export interface GitRepoState {
  isGitRepo: boolean;
  branch: string;
  headCommit: string | null;
  remoteUrl: string | null;
  workingTree: WorkingTreeSummary;
}

export function inspectGit(cwd: string = process.cwd()): GitRepoState {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" });
  } catch {
    return {
      isGitRepo: false,
      branch: "main",
      headCommit: null,
      remoteUrl: null,
      workingTree: {
        clean: true,
        changedPaths: [],
        untrackedPaths: [],
      },
    };
  }

  // Branch
  let branch = "main";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    // Empty repository or detached HEAD
  }

  // Head commit
  let headCommit: string | null = null;
  try {
    headCommit = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    // Initial commit not made yet
  }

  // Remote URL
  let remoteUrl: string | null = null;
  try {
    remoteUrl = execSync("git config --get remote.origin.url", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    // No remote
  }

  // Status
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  try {
    const statusOutput = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    const lines = statusOutput.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (status.includes("?")) {
        untrackedPaths.push(filePath);
      } else {
        changedPaths.push(filePath);
      }
    }
  } catch {
    // Ignore error
  }

  // Capture in-progress git diff patch (capped at 25KB for safety)
  let diffPatch: string | undefined = undefined;
  let diffSummary: string | undefined = undefined;
  try {
    const rawDiff = execSync("git diff HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 1024 * 512 });
    if (rawDiff.trim().length > 0) {
      const sanitized = redactSecrets(rawDiff);
      diffPatch = sanitized.length > 25000 ? sanitized.slice(0, 25000) + "\n... [diff truncated for length]" : sanitized;
      diffSummary = `${changedPaths.length} modified files, ${diffPatch.split("\n").length} diff lines`;
    }
  } catch {
    // Diff unavailable
  }

  return {
    isGitRepo: true,
    branch: branch || "main",
    headCommit,
    remoteUrl,
    workingTree: {
      clean: changedPaths.length === 0 && untrackedPaths.length === 0,
      branch: branch || "main",
      changedPaths,
      untrackedPaths,
      diffSummary,
      diffPatch,
    },
  };
}
