import type { ExecutionEvidence, Experiment } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { executeTaskProbes } from "../probes.ts";

export function executeExperiments(context: TaskContext<"adversarial">, experiments: Experiment[], artifactGroup = "artifacts/tasks/adversarial/experiments"): Promise<{ evidence: ExecutionEvidence[]; errors: string[] }> {
  return executeTaskProbes(context, experiments, {
    stage: "generate",
    timeoutMs: context.options.experimentTimeoutMs,
    artifactGroup,
  });
}
