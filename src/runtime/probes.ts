import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { mapSettledLimit } from "./concurrency.ts";
import { cloneDirectory, referenceDirectory } from "./source.ts";
import { SourcePool } from "./source-pool.ts";
import { writeExperiment } from "./experiments.ts";
import { hashDirectory } from "./repository.ts";
import type { ExecutionEvidence, Experiment, Snapshot, SourceWorkspacePool } from "../shared/types.ts";
import type { ExperimentExecutor, ReviewOptions, Stage, TaskName } from "../shared/types.ts";

export interface ProbeExecutionContext {
  snapshots: { base: Snapshot; head: Snapshot };
  directory: string;
  workspace: string;
  executor: ExperimentExecutor;
  sourcePool?: SourceWorkspacePool;
  concurrency: number;
  timeoutMs: number;
  task: TaskName;
  stage: Stage;
  artifactGroup: string;
  revisions?: Record<string, ("base" | "head")[]>;
  dependencyRoots?: Partial<Record<"base" | "head", string>>;
  signal?: AbortSignal;
  onEvent?: ReviewOptions["onEvent"];
}

interface PreparedProbe { experiment: Experiment; payload: string; digest: string; index: number }
interface ProbeJob { probe: PreparedProbe; revision: "base" | "head"; snapshot: Snapshot; order: number }

/** Parallel-safe probes use a bounded pool; serial probes run after that pool drains. */
export async function executeProbes(context: ProbeExecutionContext, experiments: Experiment[]): Promise<{ evidence: ExecutionEvidence[]; errors: string[] }> {
  const concurrency = context.concurrency;
  const errors: string[] = [];
  const prepared = await mapSettledLimit(experiments, concurrency, async (experiment, index): Promise<PreparedProbe> => {
    const payload = path.join(context.directory, context.artifactGroup, experiment.id, "files");
    const digest = await writeExperiment(experiment, payload);
    const reference = path.join(context.workspace, "probes", experiment.id);
    // Setup rechecks use new log directories but the same task navigation entry.
    await rm(reference, { force: true });
    await referenceDirectory(payload, reference);
    return { experiment, payload, digest, index };
  }, context.signal);
  const jobs: ProbeJob[] = [];
  prepared.forEach((outcome, index) => {
    if (outcome.status === "rejected") { errors.push(`${experiments[index]!.id}: ${errorMessage(outcome.reason)}`); return; }
    for (const [offset, revision] of (context.revisions?.[outcome.value.experiment.id] ?? ["base", "head"] as const).entries()) {
      jobs.push({ probe: outcome.value, revision, snapshot: context.snapshots[revision], order: outcome.value.index * 2 + offset });
    }
  });

  const pool = context.sourcePool ?? new SourcePool(path.join(context.directory, context.artifactGroup, "execution-workspaces"), Math.max(2, concurrency));
  const execute = async (job: ProbeJob): Promise<ExecutionEvidence> => {
    context.signal?.throwIfAborted();
    const { experiment, digest, payload } = job.probe;
    const artifacts = path.join(context.directory, context.artifactGroup, experiment.id, job.revision);
    const payloadDirectory = path.join(artifacts, "files");
    await cloneDirectory(payload, payloadDirectory);
    // Durable source navigation points to the single freeze. Actual execution uses
    // an exclusive temporary lease, recorded separately for provenance.
    await referenceDirectory(job.snapshot.directory, path.join(artifacts, "source"));
    return pool.use(job.snapshot, context.dependencyRoots?.[job.revision], async snapshot => {
      if (await hashDirectory(payloadDirectory) !== digest) throw new Error("Probe copy differs from the frozen payload");
      await writeFile(path.join(artifacts, "source-reference.json"), JSON.stringify({
        revision: job.revision, commit: snapshot.commit, source: job.snapshot.directory,
        sourceSha256: snapshot.sha256, executionDirectory: snapshot.directory, payloadSha256: digest,
        note: "Execution source is an exclusive temporary copy, verified before reuse and removed when the review ends.",
      }, null, 2));
      context.onEvent?.({ task: context.task, kind: "progress", stage: context.stage, message: `${context.task}: executing ${experiment.id} on ${job.revision}` });
      const record = await context.executor.execute({ experiment, snapshot, revision: job.revision, payloadDirectory,
        artifacts, timeoutMs: context.timeoutMs, signal: context.signal });
      if (record.commit !== snapshot.commit || record.payloadSha256 !== digest || record.revision !== job.revision || record.experimentId !== experiment.id || record.hypothesisId !== experiment.hypothesisId) throw new Error("Executor returned inconsistent provenance");
      if (await hashDirectory(payloadDirectory) !== digest) throw new Error("Probe files changed after execution");
      return record;
    });
  };

  const completed = new Map<number, ExecutionEvidence>();
  async function runGroup(group: ProbeJob[], limit: number): Promise<void> {
    const outcomes = await mapSettledLimit(group, limit, execute, context.signal);
    outcomes.forEach((outcome, index) => {
      const job = group[index]!;
      if (outcome.status === "fulfilled") completed.set(job.order, outcome.value);
      else errors.push(`${job.probe.experiment.id}:${job.revision}: ${errorMessage(outcome.reason)}`);
    });
  }
  try {
    await runGroup(jobs.filter(job => job.probe.experiment.parallelSafe), concurrency);
    await runGroup(jobs.filter(job => !job.probe.experiment.parallelSafe), 1);
  } finally {
    if (!context.sourcePool) await pool.close();
  }
  return { evidence: [...completed.entries()].sort(([a], [b]) => a - b).map(([, record]) => record), errors };
}
