import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpServerConfig {
  apiBaseUrl?: string;
}

export function createCtxMcpServer(config: McpServerConfig = {}): McpServer {
  const baseUrl = (config.apiBaseUrl || process.env.CTX_API_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");

  const server = new McpServer({
    name: "ctx-context-runtime",
    version: "0.1.0",
  });

  // Helper fetch function
  async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Context API error (${res.status}): ${errText}`);
    }
    return (await res.json()) as T;
  }

  // 1. ctx_project_resolve
  server.tool(
    "ctx_project_resolve",
    "Resolve or register a project identity by name or git remote URL",
    {
      projectName: z.string().optional().describe("Local project or folder name"),
      gitRemoteUrl: z.string().optional().describe("Normalized Git remote repository URL"),
    },
    async ({ projectName, gitRemoteUrl }) => {
      try {
        const project = await apiFetch<any>("/v1/projects/resolve", {
          method: "POST",
          body: JSON.stringify({ projectName, gitRemoteUrl }),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error resolving project: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. ctx_get_status
  server.tool(
    "ctx_get_status",
    "Get current project status, active task, branch, and latest checkpoint version",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
    },
    async ({ projectId }) => {
      try {
        const project = await apiFetch<any>(`/v1/projects/${projectId}`);
        const checkpoint = await apiFetch<any>(`/v1/projects/${projectId}/checkpoints/latest`).catch(
          () => null
        );
        const task = checkpoint?.taskId
          ? await apiFetch<any>(`/v1/tasks/${checkpoint.taskId}`).catch(() => null)
          : null;

        const summary = {
          projectId: project.id,
          projectName: project.name,
          defaultBranch: project.defaultBranch,
          latestCheckpoint: checkpoint
            ? {
                version: checkpoint.version,
                id: checkpoint.id,
                branch: checkpoint.branch,
                validityStatus: checkpoint.validityStatus,
                nextAction: checkpoint.state?.nextAction,
                lastVerifiedAt: checkpoint.createdAt,
              }
            : null,
          activeTask: task
            ? {
                id: task.id,
                title: task.title,
                status: task.status,
                nextAction: task.nextAction,
              }
            : null,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error fetching project status: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. ctx_get_checkpoint
  server.tool(
    "ctx_get_checkpoint",
    "Retrieve the latest verified project checkpoint or checkpoint history",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      latestOnly: z.boolean().default(true).describe("Whether to fetch only the latest checkpoint"),
    },
    async ({ projectId, latestOnly }) => {
      try {
        if (latestOnly) {
          const checkpoint = await apiFetch<any>(`/v1/projects/${projectId}/checkpoints/latest`);
          return {
            content: [{ type: "text", text: JSON.stringify(checkpoint, null, 2) }],
          };
        } else {
          const checkpoints = await apiFetch<any[]>(`/v1/projects/${projectId}/checkpoints`);
          return {
            content: [{ type: "text", text: JSON.stringify(checkpoints, null, 2) }],
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error fetching checkpoint: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 4. ctx_save_checkpoint
  server.tool(
    "ctx_save_checkpoint",
    "Record an immutable checkpoint of the current verified project and task state",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      taskId: z.string().uuid().optional().describe("Optional active task UUID"),
      branch: z.string().describe("Active Git branch"),
      gitCommit: z.string().optional().describe("Current HEAD commit hash"),
      workingTreeClean: z.boolean().describe("Whether working tree has uncommitted changes"),
      changedPaths: z.array(z.string()).default([]).describe("List of modified files"),
      completedItems: z
        .array(
          z.object({
            description: z.string(),
            evidence: z.string().optional(),
          })
        )
        .default([]),
      pendingItems: z.array(z.string()).default([]),
      decisions: z.array(z.string()).default([]),
      nextAction: z.string().describe("Specific next step for the resuming agent"),
    },
    async ({
      projectId,
      taskId,
      branch,
      gitCommit,
      workingTreeClean,
      changedPaths,
      completedItems,
      pendingItems,
      decisions,
      nextAction,
    }) => {
      try {
        const payload = {
          taskId,
          branch,
          gitCommit,
          workingTree: {
            clean: workingTreeClean,
            changedPaths,
            untrackedPaths: [],
          },
          state: {
            completed: completedItems.map((c) => ({
              description: c.description,
              evidence: c.evidence,
              timestamp: new Date().toISOString(),
            })),
            pending: pendingItems,
            decisions: decisions.map((d) => ({ decision: d })),
            blockers: [],
            nextAction,
          },
        };

        const checkpoint = await apiFetch<any>(`/v1/projects/${projectId}/checkpoints`, {
          method: "POST",
          body: JSON.stringify(payload),
        });

        return {
          content: [
            {
              type: "text",
              text: `✓ Checkpoint v${checkpoint.version} recorded successfully (ID: ${checkpoint.id}). Next action: ${nextAction}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error recording checkpoint: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 5. ctx_record_decision
  server.tool(
    "ctx_record_decision",
    "Store an architectural decision or project rule in persistent semantic memory",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      title: z.string().describe("Short decision title"),
      content: z.string().describe("Detailed architectural decision or constraint"),
      type: z.enum(["decision", "fact", "procedure", "note"]).default("decision"),
    },
    async ({ projectId, title, content, type }) => {
      try {
        const memory = await apiFetch<any>(`/v1/projects/${projectId}/memories`, {
          method: "POST",
          body: JSON.stringify({
            projectId,
            type,
            title,
            content,
            sourceType: "mcp_agent",
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: `✓ Memory entry recorded: [${memory.type.toUpperCase()}] "${memory.title}"`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error recording decision: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 6. ctx_assemble_context
  server.tool(
    "ctx_assemble_context",
    "Compile and optimize context package for resuming a task using TOON/JSON",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      taskId: z.string().uuid().optional().describe("Optional task UUID to resume"),
      formatPreference: z
        .enum(["auto", "toon", "json"])
        .default("auto")
        .describe("Context serialization format"),
      tokenBudget: z.number().int().default(8000).describe("Token budget ceiling"),
    },
    async ({ projectId, taskId, formatPreference, tokenBudget }) => {
      try {
        const assembled = await apiFetch<any>(`/v1/projects/${projectId}/context/assemble`, {
          method: "POST",
          body: JSON.stringify({
            taskId,
            formatPreference,
            tokenBudget,
          }),
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `=== ASSEMBLED CONTEXT (Format: ${assembled.format.toUpperCase()}, Tokens: ~${assembled.estimatedTokens}) ===`,
                `Savings vs JSON: ${assembled.savingsPercent}%`,
                "",
                assembled.content,
              ].join("\n"),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error assembling context: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 7. ctx_update_task
  server.tool(
    "ctx_update_task",
    "Update task status, priority, or next action with optimistic concurrency conflict detection",
    {
      taskId: z.string().uuid().describe("Unique task UUID"),
      status: z.enum(["pending", "in_progress", "blocked", "completed", "cancelled"]).optional(),
      nextAction: z.string().optional(),
      title: z.string().optional(),
      expectedVersion: z.number().int().positive().optional().describe("Expected task version to prevent race conditions"),
    },
    async ({ taskId, status, nextAction, title, expectedVersion }) => {
      try {
        const updated = await apiFetch<any>(`/v1/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ status, nextAction, title, expectedVersion }),
        });

        return {
          content: [
            {
              type: "text",
              text: `✓ Task "${updated.title}" updated: status=${updated.status}, nextAction="${updated.nextAction}" (version: ${updated.currentVersion})`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error updating task: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 8. ctx_record_event
  server.tool(
    "ctx_record_event",
    "Record an agent activity or milestone event in the append-only audit stream",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      taskId: z.string().uuid().optional().describe("Associated task UUID"),
      eventType: z.string().describe("Event name, e.g. test_executed, file_refactored"),
      payload: z.record(z.unknown()).default({}).describe("JSON payload of event details"),
    },
    async ({ projectId, taskId, eventType, payload }) => {
      try {
        const event = await apiFetch<any>(`/v1/projects/${projectId}/events`, {
          method: "POST",
          body: JSON.stringify({ projectId, taskId, eventType, payload }),
        });

        return {
          content: [
            {
              type: "text",
              text: `✓ Event recorded: [${event.eventType}] at ${event.createdAt} (ID: ${event.id})`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error recording event: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 9. ctx_list_events
  server.tool(
    "ctx_list_events",
    "Retrieve the append-only audit event trail for a project or task",
    {
      projectId: z.string().uuid().describe("Unique project UUID"),
      taskId: z.string().uuid().optional().describe("Optional task filter"),
    },
    async ({ projectId, taskId }) => {
      try {
        const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
        const events = await apiFetch<any[]>(`/v1/projects/${projectId}/events${query}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(events, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error listing events: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
