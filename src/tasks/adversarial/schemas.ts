import { array, identifier, object, strings, text } from "../../shared/schema.ts";
import type { ExecutionEvidence, Hypothesis, JsonSchema } from "../../shared/types.ts";

export function investigationSchemaFor(changedFiles: string[], maxHypotheses: number): JsonSchema {
  const file = { type: "string", enum: changedFiles };
  return object({
    hypotheses: array(object({ id: identifier, title: text, severity: { enum: ["high", "medium", "low"] },
      claim: text, invariant: text, expectationSource: text,
      changedFiles: { type: "array", items: file, minItems: 1, maxItems: 5000 }, testIdea: text }), maxHypotheses),
    examinedFiles: { type: "array", items: file, maxItems: 5000 },
    skippedFiles: array(object({ path: file, reason: text }), 5000), notes: strings,
  });
}

export function generationSchemaFor(hypotheses: Hypothesis[], maxExperimentsPerHypothesis: number): JsonSchema {
  const hypothesisId = { type: "string", enum: hypotheses.map(item => item.id) };
  return object({
    experiments: array(object({ id: identifier, hypothesisId, description: text, parallelSafe: { type: "boolean" },
      files: { ...array(object({ path: text, content: { type: "string", minLength: 1, maxLength: 100000 } }), 10), minItems: 1 },
      argv: { ...strings, minItems: 1, maxItems: 32 },
    }), hypotheses.length * maxExperimentsPerHypothesis),
    skipped: array(object({ hypothesisId, reason: text }), hypotheses.length),
  });
}

export const assessmentSchema = object({
  findings: array(object({ hypothesisId: identifier, verdict: { enum: ["defect", "unsupported", "inconclusive"] },
    confidence: { enum: ["high", "medium", "low"] }, explanation: text,
    expectationJustification: text, evidenceIds: { ...strings, maxItems: 100 },
  })),
});


/** Require every available execution ID, rather than allowing a one-sided defect claim. */
export function assessmentSchemaFor(hypotheses: Hypothesis[], evidence: ExecutionEvidence[]): JsonSchema {
  const outcomes = hypotheses.map(hypothesis => {
    const ids = evidence.filter(item => item.hypothesisId === hypothesis.id).map(item => item.id);
    return object({ hypothesisId: { type: "string", enum: [hypothesis.id] }, verdict: { enum: ["defect", "unsupported", "inconclusive"] },
      confidence: { enum: ["high", "medium", "low"] }, explanation: text, expectationJustification: text,
      evidenceIds: { type: "array", items: ids.length ? { type: "string", enum: ids } : text, minItems: ids.length, maxItems: ids.length },
    });
  });
  return object({ findings: { type: "array", items: { anyOf: outcomes }, minItems: hypotheses.length, maxItems: hypotheses.length } });
}
