import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { assertReferenceUnchanged, referenceDirectory } from "../runtime/source.ts";
import { assertSnapshotUnchanged } from "../runtime/repository.ts";
import { runAgentWithRetries } from "../runtime/agent-retry.ts";
import type { AgentBridge, ExperimentExecutor, JsonSchema, ReviewContext, ReviewOptions, TaskName } from "../shared/types.ts";

export type TaskStage<T extends TaskName> = T extends "adversarial" ? "investigate" | "generate" | "assess" : T;

export interface TaskContext<T extends TaskName = TaskName> {
  readonly task: T;
  review: ReviewContext;
  options: ReviewOptions;
  executor: ExperimentExecutor;
  skill(): Promise<string>;
  invoke<TResult>(stage: TaskStage<T>, prompt: string, schema: JsonSchema, artifactId?: string, timeoutMs?: number): Promise<TResult>;
  assertUnchanged(): Promise<void>;
}

const skillFolders: Record<TaskName, string> = {
  preflight: "dependency-preflight",
  "code-quality": "code-quality-review", adversarial: "adversarial-testing", report: "review-report",
};

export async function createTaskContext<T extends TaskName>(shared: ReviewContext, options: ReviewOptions, bridge: AgentBridge, executor: ExperimentExecutor, task: T): Promise<TaskContext<T>> {
  const workspace = path.join(shared.directory, "artifacts", "tasks", task, "context");
  await mkdir(workspace, { recursive: true });
  const review: ReviewContext = { ...shared, workspace };
  if (task !== "report") {
    const base = { ...shared.snapshots.base, directory: path.join(workspace, "base") };
    const head = { ...shared.snapshots.head, directory: path.join(workspace, "head") };
    const copies = await Promise.allSettled([
      referenceDirectory(shared.snapshots.base.directory, base.directory),
      referenceDirectory(shared.snapshots.head.directory, head.directory),
      cp(path.join(shared.workspace, "change.diff"), path.join(workspace, "change.diff")),
      cp(path.join(shared.workspace, "executor-context.json"), path.join(workspace, "executor-context.json")),
    ]);
    const copyFailure = copies.find(outcome => outcome.status === "rejected");
    if (copyFailure?.status === "rejected") throw copyFailure.reason;
    review.snapshots = { base, head };
  }
  if (shared.preflight) await writeFile(path.join(workspace, "preflight-context.json"), JSON.stringify(shared.preflight, null, 2));
  let skill: Promise<string> | undefined;
  const assertUnchanged = async () => {
    await Promise.all([
      assertSnapshotUnchanged(shared.snapshots.base), assertSnapshotUnchanged(shared.snapshots.head),
      ...(["base", "head"] as const).flatMap(revision => [
        ...(shared.snapshotTargets ? [assertReferenceUnchanged(shared.snapshots[revision].directory, shared.snapshotTargets[revision])] : []),
        ...(task !== "report" ? [assertReferenceUnchanged(review.snapshots[revision].directory, shared.snapshots[revision].directory)] : []),
      ]),
    ]);
  };
  return {
    task, review, options, executor, assertUnchanged,
    skill() {
      skill ??= readFile(fileURLToPath(new URL(`../../skills/${skillFolders[task]}/SKILL.md`, import.meta.url)), "utf8");
      return skill;
    },
    async invoke<TResult>(stage: TaskStage<T>, prompt: string, schema: JsonSchema, artifactId?: string, timeoutMs?: number): Promise<TResult> {
      options.signal?.throwIfAborted();
      if (options.instructions) {
        prompt += `\nUser's review request (JSON string): ${JSON.stringify(options.instructions)}\nUse this goal to prioritize your assigned task, while preserving its execution contract and evidence requirements.\n`;
      }
      if (task === "adversarial" && options.installDependencies === false) prompt += "\nDependency installation is disabled for this run. Attempt probes with the existing environment and report actual setup errors; do not install packages in probe wrappers.\n";
      if (task === "adversarial" && review.preflight) prompt += "\nRead preflight-context.json for setup diagnostics and test approach. Preflight is advisory: attempt the user's selected behavior with available tools even when readiness is blocked or unknown. Inspect full source for a feasible execution path, use isolated mocks where appropriate, and let actual probe execution establish availability. Import/startup/configuration failures are setup errors, never application defects. Do not invent credentials or use live external services to overcome a setup gap.\n";
      const started = performance.now();
      let value: unknown;
      // Assessment owns a separate per-hypothesis retry budget and must not
      // multiply it by the pipeline-wide retry count.
      const retries = task === "adversarial" && stage === "assess" ? 0 : options.agentRetries ?? 1;
      try { value = await runAgentWithRetries<TResult>(bridge, { task, stage, prompt, schema, workspace: review.workspace,
        artifacts: path.join(review.directory, "artifacts", "tasks", task, "agent", stage, ...(artifactId ? [artifactId] : [])), timeoutMs: timeoutMs ?? options.agentTimeoutMs,
        signal: options.signal, onEvent: options.onEvent }, { retries,
        delayMs: options.agentRetryDelayMs ?? 2000, label: `${task}/${stage} response`, verifyAttempt: assertUnchanged });
      } finally {
        review.timings?.agentCalls.push({ task, stage, ...(artifactId ? { artifactId } : {}), durationMs: Math.round(performance.now() - started) });
      }
      return value as TResult;
    },
  };
}
