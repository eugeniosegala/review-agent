import { array, identifier, object, strings, text } from "../../shared/schema.ts";
import type { JsonSchema } from "../../shared/types.ts";

export function codeQualitySchema(changedFiles: string[], maxFindings: number, chunks: string[]): JsonSchema {
  const changed = { type: "string", enum: changedFiles };
  return object({
    findings: array(object({
      id: identifier, title: text, category: { enum: ["duplication", "duplicate-string", "hardcoded-constant", "reuse", "responsibility"] },
      origin: { enum: ["introduced", "pre_existing"] }, severity: { enum: ["high", "medium", "low"] },
      explanation: text, recommendation: text,
      changedFiles: { type: "array", items: changed, minItems: 1, maxItems: 5000 },
      locations: { ...array(object({ revision: { enum: ["base", "head"] },
        path: text,
        line: { type: "integer", minimum: 1, maximum: 500000 }, snippet: text }), 8), minItems: 1 },
    }), maxFindings),
    examinedFiles: { type: "array", items: changed, maxItems: 5000 },
    reviewedChunks: { type: "array", items: { type: "string", enum: chunks }, maxItems: chunks.length },
    moreFindings: { type: "boolean" },
    skippedFiles: array(object({ path: changed, reason: text }), 5000), notes: strings,
  });
}
