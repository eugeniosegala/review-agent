import { array, object, text } from "../shared/schema.ts";
import { integerSchema, limits } from "../shared/limits.ts";
import type { AnalysisName, JsonSchema } from "../shared/types.ts";

export interface ReviewPlan {
  comparison: { kind: "working-tree" | "commit" | "branch" | "repository"; ref: string | null; baseRef: string | null };
  reviewScope: "changes" | "all";
  installDependencies: boolean;
  focus: string[];
  analyses: AnalysisName[];
  maxHypotheses: number;
  maxExperimentsPerHypothesis: number;
  maxQualityFindings: number;
  perTaskConcurrency: number;
  agentTimeoutSeconds: number;
  testTimeoutSeconds: number;
  summary: string;
  clarification: string | null;
}

export function planSchema(): JsonSchema {
  return object({
    comparison: object({ kind: { enum: ["working-tree", "commit", "branch", "repository"] },
      ref: { anyOf: [text, { type: "null" }] }, baseRef: { anyOf: [text, { type: "null" }] } }),
    reviewScope: { enum: ["changes", "all"] },
    installDependencies: { type: "boolean" },
    focus: array(text, 50),
    analyses: { type: "array", items: { type: "string", enum: ["code-quality", "adversarial"] }, minItems: 1, maxItems: 2 },
    maxHypotheses: integerSchema(limits.hypotheses),
    maxExperimentsPerHypothesis: integerSchema(limits.experimentsPerHypothesis),
    maxQualityFindings: integerSchema(limits.qualityFindings),
    perTaskConcurrency: integerSchema(limits.perTaskConcurrency),
    agentTimeoutSeconds: integerSchema(limits.timeoutSeconds),
    testTimeoutSeconds: integerSchema(limits.timeoutSeconds),
    summary: text, clarification: { anyOf: [text, { type: "null" }] },
  });
}
