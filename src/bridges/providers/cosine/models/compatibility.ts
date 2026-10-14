import { isDeepStrictEqual } from "node:util";
import type { ReasoningEffort, StructuredOutputMode } from "../../../bridge.ts";

/** Keep model-family exceptions in this module so the provider bridge stays generic. */

/** Lumen models currently work reliably with JSON-in-prompt but can stall or emit raw tool markers
 * when Cosine's native --response-format is active. The local bridge still validates the exact schema. */
export function cosineStructuredOutputMode(model: string | undefined, requested: StructuredOutputMode = "auto"): Exclude<StructuredOutputMode, "auto"> {
  if (requested !== "auto") return requested;
  const normalized = model?.trim().toLowerCase();
  return !normalized || normalized === "auto" || normalized.startsWith("lumen-") ? "prompt" : "native";
}

/** Translate shared reasoning aliases to the range currently accepted by Cosine models. */
export function cosineReasoning(effort: ReasoningEffort | undefined): string | undefined {
  if (effort === "minimal") return "low";
  if (effort === "ultra") return "max";
  return effort;
}

function parseRepeatedJson(output: string): unknown | undefined {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < output.length; index++) {
    const character = output[index]!;
    if (start < 0) {
      if (/\s/.test(character)) continue;
      if (character !== "{" && character !== "[") return undefined;
      start = index;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    if (depth < 0) return undefined;
    if (depth === 0) {
      try { values.push(JSON.parse(output.slice(start, index + 1))); }
      catch { return undefined; }
      start = -1;
    }
  }
  if (start >= 0 || values.length < 2) return undefined;
  return values.every(value => isDeepStrictEqual(value, values[0])) ? values[0] : undefined;
}

/** Normalize bounded model-output variations while rejecting prose and ambiguous values. */
export function normalizeCosineModelOutput(output: string): unknown {
  const trimmed = output.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) return JSON.parse(fenced[1]!);
    // Cosine's premature-stop continuation can occasionally repeat the exact
    // same complete structured value. Conflicting repetitions still fail closed.
    const repeated = parseRepeatedJson(trimmed);
    if (repeated !== undefined) return repeated;
    throw new Error("Cosine output was not one JSON value, one JSON code fence, or identical repeated JSON values");
  }
}
