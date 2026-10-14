import { Ajv } from "ajv";
import type { JsonSchema } from "./types.ts";

export const text = { type: "string", minLength: 1, maxLength: 12000 };
export const identifier = { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" };
export const strings = { type: "array", items: text, maxItems: 5000 };
export const object = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
export const array = (items: JsonSchema, maxItems = 20): JsonSchema => ({ type: "array", items, maxItems });

const validator = new Ajv({ allErrors: true, strict: false });
export function validatePayload<T>(schema: JsonSchema, value: unknown, label: string): T {
  if (!validator.validate(schema, value)) throw new Error(`${label} has an invalid shape: ${validator.errorsText()}`);
  return value as T;
}
