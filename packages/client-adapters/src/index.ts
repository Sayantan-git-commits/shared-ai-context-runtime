import type { EncodedContext } from "@ctx/schemas";

export interface ResumeResult {
  mode: "injected" | "prompt-ready";
  message: string;
  promptText: string;
  clientType: string;
}

export interface AgentClientAdapter {
  id: string;
  name: string;
  detect(): Promise<boolean>;
  getClientInfo(): Promise<{ clientType: string; version?: string }>;
  prepareResume(context: EncodedContext, metadata?: Record<string, unknown>): Promise<ResumeResult>;
}

/**
 * Generic Prompt Handoff Adapter.
 * Prepares a clean, high-density prompt suitable for copy-pasting or feeding to any LLM CLI/UI.
 */
export class PromptHandoffAdapter implements AgentClientAdapter {
  public readonly id = "prompt-handoff";
  public readonly name = "Generic Prompt Handoff";

  public async detect(): Promise<boolean> {
    return true; // Fallback always available
  }

  public async getClientInfo(): Promise<{ clientType: string; version?: string }> {
    return { clientType: "generic-agent" };
  }

  public async prepareResume(
    context: EncodedContext,
    metadata?: Record<string, unknown>
  ): Promise<ResumeResult> {
    const promptLines: string[] = [
      "=== RESUMING PROJECT TASK CONTEXT (via ctx runtime) ===",
      `Serialization Format: ${context.format.toUpperCase()}`,
      `Estimated Input Tokens: ${context.estimatedTokens} (saved ${context.savingsPercent}% vs baseline JSON)`,
      "",
      "--- CONTEXT PACKAGE ---",
      context.serialized,
      "--- END CONTEXT PACKAGE ---",
      "",
      "Instructions for agent:",
      "1. Resume the task specified above from the current verified checkpoint.",
      "2. Check existing Git changes and tests before making modifications.",
      "3. Record decisions and update the checkpoint when reaching milestones.",
    ];

    if (metadata?.nextAction) {
      promptLines.push(`Immediate Next Action: ${metadata.nextAction}`);
    }

    const promptText = promptLines.join("\n");

    return {
      mode: "prompt-ready",
      message: "Context package assembled in prompt-ready format.",
      promptText,
      clientType: "generic-agent",
    };
  }
}

/**
 * Claude Code Adapter.
 * Integrates with Claude Code CLI conventions.
 */
export class ClaudeCodeAdapter implements AgentClientAdapter {
  public readonly id = "claude-code";
  public readonly name = "Claude Code";

  public async detect(): Promise<boolean> {
    return !!process.env.CLAUDE_CODE || !!process.env.ANTHROPIC_API_KEY;
  }

  public async getClientInfo(): Promise<{ clientType: string; version?: string }> {
    return { clientType: "claude-code" };
  }

  public async prepareResume(
    context: EncodedContext,
    metadata?: Record<string, unknown>
  ): Promise<ResumeResult> {
    const promptText = [
      `[ctx-runtime] Project: ${metadata?.projectName ?? "Current"} | Task: ${metadata?.taskTitle ?? "Active Task"}`,
      `Checkpoint: v${metadata?.checkpointVersion ?? 1} (${context.format.toUpperCase()}, ~${context.estimatedTokens} tokens)`,
      "",
      context.serialized,
      "",
      `Next Action: ${metadata?.nextAction ?? "Review checkpoint and continue"}`,
    ].join("\n");

    return {
      mode: "prompt-ready",
      message: "Ready for Claude Code session resumption.",
      promptText,
      clientType: "claude-code",
    };
  }
}

export class AdapterRegistry {
  private adapters: AgentClientAdapter[] = [];

  constructor() {
    this.register(new ClaudeCodeAdapter());
    this.register(new PromptHandoffAdapter()); // Fallback at end
  }

  public register(adapter: AgentClientAdapter): void {
    this.adapters.unshift(adapter);
  }

  public async getAdapter(preferredId?: string): Promise<AgentClientAdapter> {
    if (preferredId) {
      const match = this.adapters.find((a) => a.id === preferredId);
      if (match) return match;
    }

    for (const adapter of this.adapters) {
      if (await adapter.detect()) {
        return adapter;
      }
    }

    return new PromptHandoffAdapter();
  }
}
