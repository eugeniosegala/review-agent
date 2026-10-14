import { object, text } from "../shared/schema.ts";

export const observationSchema = object({
  status: { enum: ["pass", "violation", "error"] },
  expected: text, actual: text, details: text,
});
