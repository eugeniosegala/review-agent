import { executeProbes } from "../runtime/probes.ts";
import type { ExecutionEvidence, Experiment, TaskName } from "../shared/types.ts";
import type { TaskContext, TaskStage } from "./context.ts";

interface TaskProbeOptions<T extends TaskName> {
  stage: TaskStage<T>;
  artifactGroup: string;
  timeoutMs: number;
  revisions?: Record<string, ("base" | "head")[]>;
}

/** Adapt a bound task context to the shared probe runtime. */
export function executeTaskProbes<T extends "preflight" | "adversarial">(
  context: TaskContext<T>,
  experiments: Experiment[],
  options: TaskProbeOptions<T>,
): Promise<{ evidence: ExecutionEvidence[]; errors: string[] }> {
  return executeProbes({
    snapshots: context.review.snapshots,
    directory: context.review.directory,
    workspace: context.review.workspace,
    sourcePool: context.review.sourcePool,
    executor: context.executor,
    concurrency: context.options.perTaskConcurrency ?? 2,
    timeoutMs: options.timeoutMs,
    task: context.task,
    stage: options.stage,
    artifactGroup: options.artifactGroup,
    signal: context.options.signal,
    onEvent: context.options.onEvent,
    dependencyRoots: context.review.dependencyRoots,
    revisions: options.revisions,
  }, experiments);
}
