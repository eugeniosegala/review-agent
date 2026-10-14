import { array, identifier, object, strings, text } from "../../shared/schema.ts";

export const reportSchema = object({
  summary: text,
  priorities: array(object({ source: { enum: ["code-quality", "adversarial"] }, findingId: identifier, reason: text }), 40),
  notes: strings,
});
