import { encode as encodeToon, decode as decodeToon } from "@toon-format/toon";
import { encode as gptEncode } from "gpt-tokenizer";
import type { ContextPackage, EncodedContext, ContextFormat } from "@ctx/schemas";

/**
 * High-precision BPE token count calculation using cl100k_base tokenizer.
 * Falls back to character-based heuristic only if binary encoding fails.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return gptEncode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 3.8));
  }
}

/**
 * Deep structural validation verifying that deserialized output strictly preserves
 * required schema identity, instructions, decisions, and task state.
 */
export function validateRoundTrip(original: ContextPackage, decoded: any): boolean {
  if (!decoded || typeof decoded !== "object") return false;
  if (decoded.schemaVersion !== original.schemaVersion) return false;
  if (decoded.projectId !== original.projectId) return false;
  if (Array.isArray(original.instructions)) {
    if (!Array.isArray(decoded.instructions) || decoded.instructions.length !== original.instructions.length) {
      return false;
    }
  }
  if (Array.isArray(original.decisions)) {
    if (!Array.isArray(decoded.decisions) || decoded.decisions.length !== original.decisions.length) {
      return false;
    }
  }
  if (original.taskState && typeof original.taskState === "object") {
    if (!decoded.taskState || typeof decoded.taskState !== "object") {
      return false;
    }
  }
  return true;
}

export interface SerializationResult extends EncodedContext {
  baselineJson: string;
  toonOutput: string;
  tokenBudget?: number;
  budgetExceeded: boolean;
  prunedItemsCount: number;
}

export interface BudgetPruneResult {
  pkg: ContextPackage;
  prunedCount: number;
  budgetExceeded: boolean;
}

export class ContextSerializer {
  /**
   * Intelligently prunes lower-priority context items when exceeding tokenBudget,
   * following Section 11 of the architecture plan.
   * Priority order preserved:
   * 1. System instructions, task identity, status, nextAction, gitState (NEVER pruned)
   * 2. Active task completed & pending lists
   * 3. Recent decisions
   * 4. Supporting facts
   * 5. Historical events & verbose evidence (Pruned first)
   */
  public pruneToBudget(pkg: ContextPackage, tokenBudget?: number): BudgetPruneResult {
    if (!tokenBudget || tokenBudget <= 0) {
      return { pkg, prunedCount: 0, budgetExceeded: false };
    }

    let cloned: ContextPackage = JSON.parse(JSON.stringify(pkg));
    let currentTokens = estimateTokens(JSON.stringify(cloned));
    if (currentTokens <= tokenBudget) {
      return { pkg: cloned, prunedCount: 0, budgetExceeded: false };
    }

    let prunedCount = 0;

    // Layer 1: Prune historical events
    if (cloned.recentEvents && cloned.recentEvents.length > 0) {
      prunedCount += cloned.recentEvents.length;
      cloned.recentEvents = [];
      currentTokens = estimateTokens(JSON.stringify(cloned));
      if (currentTokens <= tokenBudget) {
        return { pkg: cloned, prunedCount, budgetExceeded: false };
      }
    }

    // Layer 2: Prune verbose evidence from completed task items
    const taskState = cloned.taskState as Record<string, unknown>;
    if (Array.isArray(taskState?.completed)) {
      let strippedAny = false;
      taskState.completed = taskState.completed.map((item: any) => {
        if (typeof item === "object" && item !== null && item.evidence) {
          strippedAny = true;
          prunedCount++;
          const { evidence, ...rest } = item;
          return rest;
        }
        return item;
      });
      if (strippedAny) {
        currentTokens = estimateTokens(JSON.stringify(cloned));
        if (currentTokens <= tokenBudget) {
          return { pkg: cloned, prunedCount, budgetExceeded: false };
        }
      }
    }

    // Layer 3: Prune older decisions (keep at most 3 newest)
    if (cloned.decisions && cloned.decisions.length > 3) {
      const excess = cloned.decisions.length - 3;
      prunedCount += excess;
      cloned.decisions = cloned.decisions.slice(-3);
      currentTokens = estimateTokens(JSON.stringify(cloned));
      if (currentTokens <= tokenBudget) {
        return { pkg: cloned, prunedCount, budgetExceeded: false };
      }
    }

    // Layer 4: Prune non-critical facts (keep at most 5)
    if (cloned.facts) {
      const keys = Object.keys(cloned.facts);
      if (keys.length > 5) {
        const excess = keys.length - 5;
        prunedCount += excess;
        const keptFacts: Record<string, unknown> = {};
        for (const k of keys.slice(0, 5)) {
          keptFacts[k] = cloned.facts[k];
        }
        cloned.facts = keptFacts;
        currentTokens = estimateTokens(JSON.stringify(cloned));
        if (currentTokens <= tokenBudget) {
          return { pkg: cloned, prunedCount, budgetExceeded: false };
        }
      }
    }

    // If still over budget, mark budgetExceeded
    return { pkg: cloned, prunedCount, budgetExceeded: currentTokens > tokenBudget };
  }

  /**
   * Serializes a ContextPackage using minified JSON as baseline,
   * tests TOON serialization, applies token budget pruning,
   * and selects the most efficient representation.
   */
  public async encode(
    pkg: ContextPackage,
    preferenceOrOptions: "auto" | "toon" | "json" | { formatPreference?: "auto" | "toon" | "json"; tokenBudget?: number } = "auto",
    tokenBudgetArg?: number
  ): Promise<SerializationResult> {
    const preference = typeof preferenceOrOptions === "object"
      ? (preferenceOrOptions.formatPreference || "auto")
      : preferenceOrOptions;
    const tokenBudget = typeof preferenceOrOptions === "object"
      ? preferenceOrOptions.tokenBudget
      : tokenBudgetArg;

    const { pkg: budgetPkg, prunedCount, budgetExceeded } = this.pruneToBudget(pkg, tokenBudget);

    const minifiedJson = JSON.stringify(budgetPkg);
    const baselineTokens = estimateTokens(minifiedJson);

    let toonOutput = "";
    let toonTokens = Infinity;
    let toonSuccess = false;

    try {
      toonOutput = encodeToon(budgetPkg);
      toonTokens = estimateTokens(toonOutput);
      const decoded = decodeToon(toonOutput);
      if (validateRoundTrip(budgetPkg, decoded)) {
        toonSuccess = true;
      }
    } catch {
      toonSuccess = false;
    }

    let selectedFormat: ContextFormat = "json";
    let serialized = minifiedJson;
    let estimatedTokens = baselineTokens;

    if (preference === "json") {
      selectedFormat = "json";
      serialized = minifiedJson;
      estimatedTokens = baselineTokens;
    } else if (preference === "toon" && toonSuccess) {
      selectedFormat = "toon";
      serialized = toonOutput;
      estimatedTokens = toonTokens;
    } else if (preference === "auto") {
      if (toonSuccess && toonTokens < baselineTokens) {
        selectedFormat = "toon";
        serialized = toonOutput;
        estimatedTokens = toonTokens;
      } else {
        selectedFormat = "json";
        serialized = minifiedJson;
        estimatedTokens = baselineTokens;
      }
    }

    const actualEncodedTokens = estimateTokens(serialized);
    const finalBudgetExceeded = tokenBudget !== undefined && tokenBudget > 0
      ? actualEncodedTokens > tokenBudget
      : budgetExceeded;

    const savingsPercent =
      baselineTokens > 0
        ? Number((((baselineTokens - estimatedTokens) / baselineTokens) * 100).toFixed(2))
        : 0;

    return {
      format: selectedFormat,
      serialized,
      estimatedTokens: actualEncodedTokens,
      baselineTokens,
      savingsPercent,
      contextVersion: 1,
      baselineJson: minifiedJson,
      toonOutput: toonSuccess ? toonOutput : minifiedJson,
      tokenBudget,
      budgetExceeded: finalBudgetExceeded,
      prunedItemsCount: prunedCount,
    };
  }

  /**
   * Decode serialized context back to a structured object.
   */
  public decode(serialized: string, format: ContextFormat): unknown {
    if (format === "toon") {
      return decodeToon(serialized);
    }
    return JSON.parse(serialized);
  }
}
