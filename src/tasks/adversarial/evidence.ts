import type { Assessment, ExecutionEvidence, Finding, Generation, Hypothesis, Investigation } from "../../shared/types.ts";
import { unique, validateExamination } from "../validation.ts";

export function validateInvestigation(investigation: Investigation, changed: string[], maxHypotheses: number): void {
  unique(investigation.hypotheses.map(h => h.id), "Hypotheses");
  validateExamination(investigation, changed);
  if (investigation.hypotheses.length > maxHypotheses) throw new Error("Agent exceeded the hypothesis budget");
  for (const item of investigation.hypotheses) {
    if (!item.changedFiles.every(file => changed.includes(file))) throw new Error(`Hypothesis ${item.id} references files outside the changed scope`);
  }
}

export function validateGeneration(generation: Generation, hypotheses: Hypothesis[], maxExperimentsPerHypothesis = 1): void {
  unique(generation.experiments.map(e => e.id), "Experiments");
  unique(generation.skipped.map(e => e.hypothesisId), "Skipped hypotheses");
  const expected = new Set(hypotheses.map(item => item.id));
  if (![...generation.experiments.map(e => e.hypothesisId), ...generation.skipped.map(e => e.hypothesisId)].every(id => expected.has(id))) {
    throw new Error("Generation references an unknown hypothesis");
  }
  for (const hypothesis of hypotheses) {
    const experiments = generation.experiments.filter(item => item.hypothesisId === hypothesis.id);
    const skipped = generation.skipped.some(item => item.hypothesisId === hypothesis.id);
    if (skipped === Boolean(experiments.length)) throw new Error("Generation must account for each hypothesis with experiments or one skip");
    if (experiments.length > maxExperimentsPerHypothesis) throw new Error(`Generation exceeded the experiment budget for ${hypothesis.id}`);
  }
  for (const experiment of generation.experiments) {
    if (experiment.argv.some(arg => arg.includes("\0")) || experiment.argv[0]!.startsWith("-")) throw new Error("Invalid experiment command");
  }
}

export function classifyFinding(hypothesis: Hypothesis, assessment: Assessment["findings"][number] | undefined, evidence: ExecutionEvidence[], skipReason?: string): Finding {
  const relevant = evidence.filter(e => e.hypothesisId === hypothesis.id);
  const ids = relevant.map(e => e.id);
  const result: Finding = {
    hypothesis, status: "inconclusive", confidence: "low",
    explanation: skipReason ?? "No completed assessment is available.",
    expectationJustification: assessment?.expectationJustification ?? "The expected behavior has not been independently assessed.",
    evidenceIds: ids,
  };
  if (!assessment) return result;
  if (!assessment.evidenceIds.every(id => ids.includes(id))) throw new Error(`Assessment ${hypothesis.id} references unrelated or nonexistent evidence`);
  result.explanation = assessment.explanation;
  result.confidence = assessment.confidence;
  if (assessment.verdict === "unsupported") { result.status = "not_reproduced"; return result; }
  if (assessment.verdict === "inconclusive") return result;
  const pairs = [...new Set(relevant.map(item => item.experimentId))].map(experimentId => ({
    base: relevant.find(item => item.experimentId === experimentId && item.revision === "base"),
    head: relevant.find(item => item.experimentId === experimentId && item.revision === "head"),
  })).filter(pair => pair.base && pair.head && pair.base.payloadSha256 === pair.head.payloadSha256) as { base: ExecutionEvidence; head: ExecutionEvidence }[];
  if (!pairs.length) {
    result.explanation = "The claimed defect lacks a matching, frozen experiment on both revisions.";
    result.confidence = "low";
    return result;
  }
  if (pairs.some(pair => !assessment.evidenceIds.includes(pair.base.id) || !assessment.evidenceIds.includes(pair.head.id))) {
    result.explanation = "The claimed defect did not reference both baseline and head evidence.";
    result.confidence = "low";
    return result;
  }
  if (pairs.some(({ base, head }) => base.outcome === "pass" && head.outcome === "violation")) result.status = "reproduced_regression";
  else if (pairs.some(({ base, head }) => base.outcome === "violation" && head.outcome === "violation")) result.status = "pre_existing";
  else if (pairs.every(({ base, head }) => base.outcome !== "error" && head.outcome === "pass")) {
    result.status = "not_reproduced";
    result.explanation = "The head probe passed; the claimed defect was not reproduced. " + result.explanation;
    result.confidence = "low";
  } else {
    result.explanation = "Execution evidence is inconclusive. " + result.explanation;
    result.confidence = "low";
  }
  return result;
}
