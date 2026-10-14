import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mapSettledLimit } from "../../runtime/concurrency.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { AdversarialResult, Assessment, Hypothesis } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { unique } from "../validation.ts";
import { assessPrompt } from "./prompts.ts";
import { assessmentSchemaFor } from "./schemas.ts";

interface AssessmentResults {
  assessment: Assessment;
  errors: string[];
}

function validateSingleAssessment(assessment: Assessment, hypothesis: Hypothesis): Assessment {
  if (assessment.findings.length !== 1 || assessment.findings[0]?.hypothesisId !== hypothesis.id) {
    throw new Error(`Assessment must account for hypothesis ${hypothesis.id} exactly once`);
  }
  unique(assessment.findings[0].evidenceIds, "Assessment evidence IDs");
  return assessment;
}

/** Isolate model failures per hypothesis and apply the configured assessment retry budget. */
export async function assessHypotheses(context: TaskContext<"adversarial">, skill: string, hypotheses: Hypothesis[], result: AdversarialResult): Promise<AssessmentResults> {
  const casesDirectory = path.join(context.review.workspace, "assessment-cases");
  await mkdir(casesDirectory, { recursive: true });
  const cases = hypotheses.map(hypothesis => {
    const evidence = result.evidence.filter(item => item.hypothesisId === hypothesis.id);
    const experiments = result.generation?.experiments.filter(item => item.hypothesisId === hypothesis.id) ?? [];
    const skipped = result.generation?.skipped.find(item => item.hypothesisId === hypothesis.id) ?? null;
    const contextFile = `assessment-cases/${hypothesis.id}.json`;
    return { hypothesis, evidence, experiments, skipped, contextFile };
  });
  await Promise.all(cases.map(item => writeFile(path.join(context.review.workspace, item.contextFile), JSON.stringify({
    hypothesis: item.hypothesis, experiments: item.experiments, skipped: item.skipped,
    evidence: item.evidence, executionErrors: result.errors,
  }, null, 2))));

  const timeoutMs = Math.min(context.options.agentTimeoutMs, context.options.assessmentTimeoutMs ?? 300000);
  const invoke = async (item: typeof cases[number], attempt: number) => {
    context.options.onEvent?.({ task: "adversarial", stage: "assess", kind: "progress",
      message: `adversarial: ${attempt ? `retrying ${item.hypothesis.id} (${attempt})` : `assessing ${item.hypothesis.id}`}` });
    const assessment = await context.invoke<Assessment>("assess",
      assessPrompt(skill, item.hypothesis, item.evidence, item.contextFile),
      assessmentSchemaFor([item.hypothesis], item.evidence),
      `${item.hypothesis.id}${attempt ? attempt === 1 ? "-retry" : `-retry-${attempt}` : ""}`, timeoutMs);
    return validateSingleAssessment(assessment, item.hypothesis);
  };

  const concurrency = Math.min(context.options.assessmentConcurrency ?? 2, cases.length);
  const retryLimit = context.options.assessmentRetries ?? 1;
  const completed = new Map<number, Assessment>();
  const failures = new Map<number, unknown>();
  let pending = cases.map((_, index) => index);
  for (let attempt = 0; pending.length && attempt <= retryLimit; attempt++) {
    const indices = pending;
    const outcomes = await mapSettledLimit(indices, Math.min(concurrency, indices.length), index => invoke(cases[index]!, attempt), context.options.signal);
    pending = [];
    outcomes.forEach((outcome, offset) => {
      const index = indices[offset]!;
      if (outcome.status === "fulfilled") completed.set(index, outcome.value);
      else { failures.set(index, outcome.reason); pending.push(index); }
    });
  }
  const findings: Assessment["findings"] = [];
  const errors: string[] = [];
  for (let index = 0; index < cases.length; index++) {
    const assessment = completed.get(index);
    if (assessment) findings.push(...assessment.findings);
    else errors.push(`${cases[index]!.hypothesis.id}: assessment failed ${retryLimit === 0 ? "without a retry" : retryLimit === 1 ? "after one retry" : `after ${retryLimit} retries`}: ${errorMessage(failures.get(index))}`);
  }
  return { assessment: { findings }, errors };
}
