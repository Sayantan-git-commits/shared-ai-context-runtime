import { execSync } from "node:child_process";
import type { WorkingTreeSummary } from "@ctx/schemas";

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
      diffPatch = rawDiff.length > 25000 ? rawDiff.slice(0, 25000) + "\n... [diff truncated for length]" : rawDiff;
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
