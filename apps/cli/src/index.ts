#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { inspectGit } from "./git.js";
import { loadLocalConfig, saveLocalConfig, getCtxConfigPath } from "./config.js";
import { CtxApiClient } from "./client.js";
import { AdapterRegistry } from "@ctx/client-adapters";
import { normalizeArgv } from "./argv.js";

const program = new Command();

program
  .name("ctx")
  .description("Shared AI Context Runtime — cross-client, cross-device project memory")
  .version("0.1.0");

function resolveClient(apiOverride?: string, cwd: string = process.cwd()): CtxApiClient {
  const config = loadLocalConfig(cwd);
  const url = apiOverride || config?.api_base_url || process.env.CTX_API_URL || "http://127.0.0.1:3000";
  return new CtxApiClient(url, (config as any)?.auth_token || process.env.CTX_AUTH_TOKEN);
}

// 1. ctx init
program
  .command("init [projectPath]")
  .description("Initialize project identity and local .ctx configuration")
  .option("-n, --name <name>", "Project name override")
  .option("--api <url>", "Context API base URL", "http://127.0.0.1:3000")
  .action(async (projectPathArg, optionsArg) => {
    const projectPath = typeof projectPathArg === "string" ? projectPathArg : undefined;
    const options = typeof projectPathArg === "object" ? projectPathArg : optionsArg;
    const cwd = projectPath ? path.resolve(projectPath) : process.cwd();
    const gitState = inspectGit(cwd);
    const projectName = options.name || path.basename(cwd);

    console.log(`Resolving project identity for: ${projectName}`);
    const client = resolveClient(options.api, cwd);

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
  .command("status [projectPath]")
  .description("Display project status, latest checkpoint, and current git state")
  .action(async (projectPathArg) => {
    const cwd = projectPathArg ? path.resolve(projectPathArg) : process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error(`No .ctx configuration found at ${cwd}. Run 'ctx init' first.`);
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient(undefined, cwd);

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
  .command("checkpoint [projectPath]")
  .description("Create a checkpoint recording the current verified project state")
  .option("-m, --message <message>", "Description or next action")
  .option("--task <taskId>", "Associated task ID")
  .action(async (projectPathArg, optionsArg) => {
    const projectPath = typeof projectPathArg === "string" ? projectPathArg : undefined;
    const options = typeof projectPathArg === "object" ? projectPathArg : optionsArg;
    const cwd = projectPath ? path.resolve(projectPath) : process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error(`No .ctx configuration found at ${cwd}. Run 'ctx init' first.`);
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient(undefined, cwd);

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
  .option("--budget <number>", "Target token budget ceiling", "8000")
  .option("--ignore-drift", "Bypass Git drift warning and resume anyway")
  .action(async (projectPathArg, options) => {
    const cwd = projectPathArg ? path.resolve(projectPathArg) : process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error(`No .ctx configuration found at ${cwd}. Run 'ctx init' first.`);
      process.exit(1);
    }

    const gitState = inspectGit(cwd);
    const client = resolveClient(undefined, cwd);

    try {
      const checkpoint = await client.getLatestCheckpoint(config.project_id);
      if (!checkpoint) {
        console.log(`No checkpoint found for project ${config.project_name || config.project_id}.`);
        console.log("Run 'ctx checkpoint' to record the initial checkpoint.");
        return;
      }

      // Detect Git drift (Section 14 & 15)
      const isBranchDrift = checkpoint.branch !== gitState.branch;
      const isCommitDrift = Boolean(
        checkpoint.gitCommit && gitState.headCommit && checkpoint.gitCommit !== gitState.headCommit
      );
      const isDirtyDrift = Boolean(checkpoint.workingTree.clean !== gitState.workingTree.clean);
      const hasDrift = isBranchDrift || isCommitDrift || isDirtyDrift;

      if (hasDrift) {
        console.error("⚠️  CRITICAL GIT DRIFT DETECTED:");
        if (isBranchDrift) {
          console.error(`   • Branch changed: checkpoint was on '${checkpoint.branch}', current is '${gitState.branch}'`);
        }
        if (isCommitDrift) {
          console.error(`   • Commit changed: checkpoint commit ${checkpoint.gitCommit?.slice(0, 7)}, current HEAD ${gitState.headCommit?.slice(0, 7)}`);
        }
        if (isDirtyDrift) {
          console.error(`   • Working tree status changed: checkpoint was ${checkpoint.workingTree.clean ? "clean" : "dirty"}, current is ${gitState.workingTree.clean ? "clean" : "dirty"}`);
        }
        if (!options.ignoreDrift) {
          console.error("\n[SAFETY GATE TRIGGERED] Context resume halted to prevent state contamination across divergent branches or dirty working trees.");
          console.error("                       To override this safety check, run with: ctx continue --ignore-drift\n");
          process.exit(1);
        } else {
          console.warn("\n[SAFETY OVERRIDE] Proceeding with resume despite detected Git drift (--ignore-drift specified).\n");
        }
      }

      const tokenBudget = Number(options.budget || 8000);
      const assembled = await client.assembleContext(config.project_id, {
        taskId: checkpoint.taskId || undefined,
        formatPreference: (options.format as any) || "auto",
        clientType: options.client || "generic",
        tokenBudget,
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
      console.log(`Branch:           ${gitState.branch}${isBranchDrift ? ` (Warning: checkpoint on ${checkpoint.branch})` : ""}`);
      console.log(
        `Repository state: ${!gitState.workingTree.clean ? "working tree has uncommitted changes" : "clean"}`
      );
      console.log(`Next action:      ${checkpoint.state.nextAction || "Review checkpoint and continue"}`);
      console.log("");
      console.log(`Context format:   ${assembled.format.toUpperCase()} (saved ${assembled.savingsPercent}% tokens)`);
      console.log(`Estimated tokens: ${assembled.estimatedTokens} (budget: ${tokenBudget})`);
      if (assembled.prunedItemsCount && assembled.prunedItemsCount > 0) {
        console.log(`Budget pruning:   Pruned ${assembled.prunedItemsCount} historical items to respect ${tokenBudget} token budget`);
      }
      if (assembled.budgetExceeded) {
        console.log(`Budget warning:   Context still exceeds token ceiling (${assembled.estimatedTokens} > ${tokenBudget})`);
      }
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

// 6. ctx events
program
  .command("events")
  .description("Show append-only agent event audit trail")
  .action(async () => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const client = resolveClient();
    try {
      const events = await client.listEvents(config.project_id);
      if (events.length === 0) {
        console.log("No events recorded yet for this project.");
        return;
      }

      console.log(`Event audit stream for ${config.project_name || config.project_id}:`);
      console.log("TIMESTAMP            | EVENT TYPE           | DETAILS");
      console.log("---------------------+----------------------+------------------------------------");
      for (const ev of events) {
        const dt = (ev.createdAt || "").slice(0, 19).padEnd(20);
        const et = (ev.eventType || "").padEnd(20);
        const det = JSON.stringify(ev.payload || {}).slice(0, 50);
        console.log(`${dt} | ${et} | ${det}`);
      }
    } catch (err: any) {
      console.error(`Failed to list events: ${err.message}`);
      process.exit(1);
    }
  });

// 7. ctx memory (search & add)
const memoryCmd = program.command("memory").description("Search and manage persistent project memories");

memoryCmd
  .command("search <query>")
  .description("Search architectural decisions, facts, and rules using full-text search")
  .action(async (query: string) => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const client = resolveClient();
    try {
      const results = await client.searchMemories(config.project_id, query);
      if (results.length === 0) {
        console.log(`No memories matching "${query}".`);
        return;
      }

      console.log(`Search results for "${query}" (${results.length} found):`);
      console.log("TYPE     | TITLE                                    | RANK  | CONTENT PREVIEW");
      console.log("---------+------------------------------------------+-------+-----------------------------");
      for (const m of results) {
        const t = (m.type || "").slice(0, 8).toUpperCase().padEnd(8);
        const ti = (m.title || "").slice(0, 40).padEnd(40);
        const r = String((m.rank || 0).toFixed(2)).padEnd(5);
        const c = (m.content || "").replace(/\n/g, " ").slice(0, 40);
        console.log(`${t} | ${ti} | ${r} | ${c}...`);
      }
    } catch (err: any) {
      console.error(`Memory search failed: ${err.message}`);
      process.exit(1);
    }
  });

memoryCmd
  .command("add <title> <content>")
  .description("Add a persistent decision, fact, or procedure to project memory")
  .option("-t, --type <type>", "Memory category (decision, fact, procedure, note)", "decision")
  .action(async (title: string, content: string, options: any) => {
    const cwd = process.cwd();
    const config = loadLocalConfig(cwd);
    if (!config) {
      console.error("No .ctx configuration found. Run 'ctx init' first.");
      process.exit(1);
    }

    const client = resolveClient();
    try {
      const mem = await client.createMemory(config.project_id, {
        title,
        content,
        type: options.type || "decision",
      });
      console.log(`✓ Memory entry recorded: [${mem.type.toUpperCase()}] "${mem.title}" (ID: ${mem.id})`);
    } catch (err: any) {
      console.error(`Failed to add memory: ${err.message}`);
      process.exit(1);
    }
  });

// 8. ctx doctor
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

program.parse(normalizeArgv(process.argv));
