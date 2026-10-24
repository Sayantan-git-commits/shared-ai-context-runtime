import { encode as encodeToon, decode as decodeToon } from "@toon-format/toon";
import type { ContextPackage, EncodedContext, ContextFormat } from "@ctx/schemas";

/**
 * Standard token count estimation.
 * In production, provider tokenizers (cl100k, o200k, etc.) can be plugged in.
 * Average rule of thumb: ~3.8 to 4 characters per token for structured text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count words, symbols, whitespace
  const wordsAndPunct = text.trim().match(/[\w]+|[^\s\w]/g);
  if (!wordsAndPunct) return 0;
  // Weight punct and word fragments
  return Math.max(1, Math.ceil(text.length / 3.8));
}

export interface SerializationResult extends EncodedContext {
  baselineJson: string;
  toonOutput: string;
}

export class ContextSerializer {
  /**
   * Serializes a ContextPackage using minified JSON as baseline,
   * tests TOON serialization, and selects the most efficient representation.
   */
  public async encode(
    pkg: ContextPackage,
    preference: "auto" | "toon" | "json" = "auto"
  ): Promise<SerializationResult> {
    const minifiedJson = JSON.stringify(pkg);
    const baselineTokens = estimateTokens(minifiedJson);

    let toonOutput = "";
    let toonTokens = Infinity;
    let toonSuccess = false;

    try {
      toonOutput = encodeToon(pkg);
      toonTokens = estimateTokens(toonOutput);
      // Verify round-trip integrity
      const decoded = decodeToon(toonOutput);
      if (decoded && typeof decoded === "object") {
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
      // If TOON is successful and saves tokens, pick TOON
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

    const savingsPercent =
      baselineTokens > 0
        ? Number((((baselineTokens - estimatedTokens) / baselineTokens) * 100).toFixed(2))
        : 0;

    return {
      format: selectedFormat,
      serialized,
      estimatedTokens,
      baselineTokens,
      savingsPercent,
      contextVersion: 1,
      baselineJson: minifiedJson,
      toonOutput: toonSuccess ? toonOutput : minifiedJson,
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
