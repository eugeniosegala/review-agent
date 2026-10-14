import { assertInteger, assertMilliseconds, limits } from "../shared/limits.ts";
import type { AnalysisName, ReviewOptions } from "../shared/types.ts";

export const analysisNames = ["code-quality", "adversarial"] as const satisfies readonly AnalysisName[];

export interface ResolvedReviewOptions {
  analyses: AnalysisName[];
  reviewScope: "changes" | "all";
  comparison: "working-tree" | "commit" | "branch" | "repository";
  perTaskConcurrency: number;
}

/** Validate the public review contract once before allocating a run workspace. */
export function resolveReviewOptions(options: ReviewOptions): ResolvedReviewOptions {
  assertInteger(options.maxHypotheses, "maxHypotheses", limits.hypotheses);
  assertInteger(options.maxQualityFindings ?? 5, "maxQualityFindings", limits.qualityFindings);
  assertInteger(options.maxExperimentsPerHypothesis ?? 1, "maxExperimentsPerHypothesis", limits.experimentsPerHypothesis);
  assertInteger(options.maxCodeQualityBatches ?? 64, "maxCodeQualityBatches", limits.sourceBatches);
  assertInteger(options.maxAdversarialInvestigationBatches ?? 64, "maxAdversarialInvestigationBatches", limits.sourceBatches);
  assertInteger(options.assessmentConcurrency ?? 2, "assessmentConcurrency", limits.assessmentConcurrency);
  assertInteger(options.assessmentRetries ?? 1, "assessmentRetries", limits.assessmentRetries);
  assertInteger(options.probeRepairAttempts ?? 0, "probeRepairAttempts", limits.assessmentRetries);
  assertMilliseconds(options.agentTimeoutMs, "agentTimeoutMs");
  assertInteger(options.agentRetries ?? 1, "agentRetries", limits.agentRetries);
  const agentRetryDelayMs = options.agentRetryDelayMs ?? 2000;
  if (!Number.isInteger(agentRetryDelayMs) || agentRetryDelayMs < 0 || agentRetryDelayMs > limits.retryDelaySeconds.maximum * 1000) {
    throw new Error(`agentRetryDelayMs must be between 0 and ${limits.retryDelaySeconds.maximum * 1000}`);
  }
  assertMilliseconds(options.experimentTimeoutMs, "experimentTimeoutMs");
  assertMilliseconds(options.assessmentTimeoutMs ?? 300000, "assessmentTimeoutMs");
  assertMilliseconds(options.dependencySetupTimeoutMs ?? 300000, "dependencySetupTimeoutMs");
  const perTaskConcurrency = options.perTaskConcurrency ?? 2;
  assertInteger(perTaskConcurrency, "perTaskConcurrency", limits.perTaskConcurrency);

  const analyses = options.analyses ?? [...analysisNames];
  if (!analyses.length || new Set(analyses).size !== analyses.length || analyses.some(task => !analysisNames.includes(task))) {
    throw new Error("Select code quality, adversarial testing, or both.");
  }
  return {
    analyses,
    reviewScope: options.reviewScope ?? "changes",
    comparison: options.comparison ?? (options.workingTree ? "working-tree" : "commit"),
    perTaskConcurrency,
  };
}
