#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { inspectGit } from "./git.js";
import { loadLocalConfig, saveLocalConfig, getCtxConfigPath } from "./config.js";
import { CtxApiClient } from "./client.js";
import { AdapterRegistry } from "@ctx/client-adapters";

const program = new Command();

program
  .name("ctx")
  .description("Shared AI Context Runtime — cross-client, cross-device project memory")
  .version("0.1.0");

function resolveClient(apiOverride?: string): CtxApiClient {
  const config = loadLocalConfig();
  const url = apiOverride || config?.api_base_url || process.env.CTX_API_URL || "http://127.0.0.1:3000";
  return new CtxApiClient(url);
}

// 1. ctx init
program
  .command("init")
  .description("Initialize project identity and local .ctx configuration")
  .option("-n, --name <name>", "Project name override")
  .option("--api <url>", "Context API base URL", "http://127.0.0.1:3000")
  .action(async (options) => {
    const cwd = process.cwd();
    const gitState = inspectGit(cwd);
    const projectName = options.name || path.basename(cwd);

    console.log(`Resolving project identity for: ${projectName}`);
    const client = resolveClient(options.api);

    try {
      const project = await client.resolveProject(projectName, gitState.remoteUrl || undefined);
      saveLocalConfig(
        {
          schema_version: 1,
          project_id: project.id,
          project_name: project.name,
          api_base_url: options.api,
          default_branch: gitState.branch,
        },
        cwd
      );

      console.log(`✓ Initialized .ctx/config.json`);
      console.log(`  Project ID:   ${project.id}`);
      console.log(`  Project Name: ${project.name}`);
      console.log(`  Git Branch:   ${gitState.branch}`);
      console.log(`  API Base URL: ${options.api}`);
    } catch (err: any) {
      console.error(`Error initializing project: ${err.message}`);
      process.exit(1);
    }
  });

// 2. ctx status
program
  .command("status")
  .description("Display project status, latest checkpoint, and current git state")
  .action(async () => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient();

    try {
      const checkpoint = await client.getLatestCheckpoint(config.project_id);
      const task = checkpoint?.taskId ? await client.getTask(checkpoint.taskId) : null;

      console.log(`Project:          ${config.project_name || config.project_id}`);
      console.log(`Task:             ${task?.title || "No active task"}`);
      console.log(
        `Checkpoint:       ${checkpoint ? `v${checkpoint.version} (${checkpoint.id.slice(0, 8)})` : "No checkpoint recorded yet"}`
      );
      console.log(`Branch:           ${gitState.branch}`);
      console.log(
        `Repository state: ${gitState.workingTree.clean ? "clean" : `uncommitted changes (${gitState.workingTree.changedPaths.length} files modified)`}`
      );

      if (checkpoint) {
        console.log(`Next action:      ${checkpoint.state.nextAction || "None specified"}`);
        console.log(`Last verified:    ${checkpoint.createdAt}`);
      }
    } catch (err: any) {
      console.error(`Failed to get status: ${err.message}`);
      process.exit(1);
    }
  });

// 3. ctx checkpoint
program
  .command("checkpoint")
  .description("Create a checkpoint recording the current verified project state")
  .option("-m, --message <message>", "Description or next action")
  .option("--task <taskId>", "Associated task ID")
  .action(async (options) => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient();

    try {
      const nextAction = options.message || "Continue from current state";
      const checkpoint = await client.createCheckpoint(config.project_id, {
        taskId: options.task,
        branch: gitState.branch,
        gitCommit: gitState.headCommit,
        workingTree: gitState.workingTree,
        state: {
          completed: [
            {
              description: `Checkpoint created: ${options.message || "Manual checkpoint"}`,
              timestamp: new Date().toISOString(),
            },
          ],
          pending: [],
          decisions: [],
          blockers: [],
          nextAction,
        },
      });

      console.log(`✓ Checkpoint recorded`);
      console.log(`  Version:     v${checkpoint.version}`);
      console.log(`  Checkpoint:  ${checkpoint.id}`);
      console.log(`  Branch:      ${checkpoint.branch}`);
      console.log(`  Git Commit:  ${checkpoint.gitCommit || "(none)"}`);
      console.log(`  Next action: ${checkpoint.state.nextAction}`);
    } catch (err: any) {
      console.error(`Failed to save checkpoint: ${err.message}`);
      process.exit(1);
    }
  });

// 4. ctx continue
program
  .command("continue [projectPath]")
  .description("Resume from the latest verified checkpoint using TOON context serialization")
  .option("--client <clientType>", "Target agent client (claude-code, generic)")
  .option("--format <format>", "Context format preference (auto, toon, json)", "auto")
  .action(async (projectPathArg, options) => {
    const cwd = projectPathArg ? path.resolve(projectPathArg) : process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error(`No .ctx configuration found at ${cwd}. Run 'ctx init' first.`);
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient();

    try {
      const checkpoint = await client.getLatestCheckpoint(config.project_id);
      if (!checkpoint) {
        console.log(`No checkpoint found for project ${config.project_name || config.project_id}.`);
        console.log("Run 'ctx checkpoint' to record the initial checkpoint.");
        return;
      }

      // Detect Git drift
      const isBranchDrift = checkpoint.branch !== gitState.branch;
      const isDirty = !gitState.workingTree.clean;

      const assembled = await client.assembleContext(config.project_id, {
        taskId: checkpoint.taskId || undefined,
        formatPreference: (options.format as any) || "auto",
        clientType: options.client || "generic",
        tokenBudget: 8000,
      });

      // Prepare client adapter handoff
      const registry = new AdapterRegistry();
      const adapter = await registry.getAdapter(options.client);
      const resume = await adapter.prepareResume(
        {
          format: assembled.format,
          serialized: assembled.content,
          estimatedTokens: assembled.estimatedTokens,
          baselineTokens: assembled.baselineTokens || assembled.estimatedTokens,
          savingsPercent: assembled.savingsPercent,
          contextVersion: assembled.checkpointVersion || 1,
        },
        {
          projectName: config.project_name,
          checkpointVersion: checkpoint.version,
          nextAction: checkpoint.state.nextAction,
        }
      );

      console.log(`Project:          ${config.project_name || config.project_id}`);
      console.log(`Checkpoint:       ckpt_${checkpoint.version} (version ${checkpoint.version})`);
      console.log(`Branch:           ${gitState.branch}${isBranchDrift ? ` (Warning: checkpoint was on ${checkpoint.branch})` : ""}`);
      console.log(
        `Repository state: ${isDirty ? "working tree has uncommitted changes" : "clean"}`
      );
      console.log(`Next action:      ${checkpoint.state.nextAction || "Review checkpoint and continue"}`);
      console.log("");
      console.log(`Context format:   ${assembled.format.toUpperCase()} (saved ${assembled.savingsPercent}% tokens)`);
      console.log(`Estimated tokens: ${assembled.estimatedTokens}`);
      console.log(`Client adapter:   ${adapter.name} (${resume.mode})`);
      console.log("");
      console.log("--------------------------------------------------");
      console.log(resume.promptText);
      console.log("--------------------------------------------------");
    } catch (err: any) {
      console.error(`Failed to resume context: ${err.message}`);
      process.exit(1);
    }
  });

// 5. ctx history
program
  .command("history")
  .description("List past checkpoints for this project")
  .action(async () => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const client = resolveClient();
    try {
      const checkpoints = await client.listCheckpoints(config.project_id);
      if (checkpoints.length === 0) {
        console.log("No checkpoints found for this project.");
        return;
      }

      console.log(`Checkpoint history for ${config.project_name || config.project_id}:`);
      console.log("VERSION | CREATED AT           | BRANCH         | STATUS | NEXT ACTION");
      console.log("--------+----------------------+----------------+--------+------------------------");
      for (const ck of checkpoints) {
        const v = String(ck.version).padEnd(7);
        const dt = ck.createdAt.slice(0, 19).padEnd(20);
        const br = ck.branch.slice(0, 14).padEnd(14);
        const st = ck.validityStatus.padEnd(6);
        const act = ck.state.nextAction || "";
        console.log(`${v} | ${dt} | ${br} | ${st} | ${act}`);
      }
    } catch (err: any) {
      console.error(`Failed to list history: ${err.message}`);
      process.exit(1);
    }
  });

// 6. ctx doctor
program
  .command("doctor")
  .description("Verify local Git configuration, .ctx setup, and API connectivity")
  .action(async () => {
    console.log("Diagnosing ctx environment...\n");
    const cwd = process.cwd();

    // 1. Git check
    const git = inspectGit(cwd);
    if (git.isGitRepo) {
      console.log(`[PASS] Git repository detected (branch: ${git.branch})`);
    } else {
      console.log(`[WARN] Not inside a git repository`);
    }

    // 2. Config check
    const config = loadLocalConfig(cwd);
    if (config) {
      console.log(`[PASS] .ctx/config.json found (project: ${config.project_name || config.project_id})`);
      console.log(`       Config path: ${getCtxConfigPath(cwd)}`);
    } else {
      console.log(`[INFO] No local .ctx configuration. Run 'ctx init' to link.`);
    }

    // 3. API connectivity check
    const client = resolveClient();
    const isApiHealthy = await client.checkHealth();
    if (isApiHealthy) {
      console.log(`[PASS] Context API reachable at ${config?.api_base_url || "default URL"}`);
    } else {
      console.log(`[WARN] Context API unreachable at ${config?.api_base_url || "http://127.0.0.1:3000"} (run API or start it)`);
    }

    console.log("\nDiagnostics complete.");
  });

program.parse(process.argv);
