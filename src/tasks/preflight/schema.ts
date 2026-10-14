import { array, identifier, object, strings, text } from "../../shared/schema.ts";
import type { JsonSchema } from "../../shared/types.ts";

const revision = { type: "string", enum: ["base", "head"] };
export const preflightCheckSchema = object({
  parallelSafe: { type: "boolean" },
  files: array(object({ path: text, content: text }), 20),
  argv: { type: "array", items: text, minItems: 1, maxItems: 50 },
});

export function preflightSchemaFor(files: string[]): JsonSchema {
  const file = files.length ? { type: "string", enum: files } : { type: "string", pattern: "^$a" };
  return object({
    approach: text,
    requirements: { type: "array", minItems: 0, maxItems: 20, items: object({
      id: identifier,
      category: { type: "string", enum: ["runtime", "package", "build", "configuration", "service", "startup"] },
      description: text, required: { type: "boolean" },
      revisions: { type: "array", items: revision, minItems: 1, maxItems: 2 },
      sources: { type: "array", items: object({ revision, path: file }), minItems: 1, maxItems: 20 },
      remediation: text,
      check: { anyOf: [preflightCheckSchema, { type: "null" }] },
    }) },
    examinedFiles: { type: "array", items: file, maxItems: 5000 },
    skippedFiles: array(object({ path: file, reason: text }), 5000),
    notes: strings,
  });
}
