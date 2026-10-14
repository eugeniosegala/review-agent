import path from "node:path";
import { performance } from "node:perf_hooks";
import { errorMessage } from "../shared/errors.ts";
import type { AnalysisName, ReviewOptions, ReviewReport, TaskName, TaskResult, TaskRun } from "../shared/types.ts";
import { saveTaskProgress, taskFile } from "../tasks/report/render.ts";

export const taskNames = ["preflight", "code-quality", "adversarial", "report"] as const satisfies readonly TaskName[];

function isSelected(name: TaskName, analyses: readonly AnalysisName[]): boolean {
  if (name === "report") return true;
  if (name === "preflight") return analyses.includes("adversarial");
  return analyses.includes(name);
}

export function createTaskRuns(analyses: readonly AnalysisName[]): TaskRun[] {
  return taskNames.map(name => ({
    name,
    status: isSelected(name, analyses) ? "pending" : "skipped",
    startedAt: null,
    finishedAt: null,
    errors: [],
  }));
}

/** Owns task lifecycle, progress publication, timings, and events for one review run. */
export class ReviewTaskRunner {
  private publication = Promise.resolve();
  private readonly report: ReviewReport;
  private readonly directory: string;
  private readonly onEvent?: ReviewOptions["onEvent"];

  constructor(report: ReviewReport, directory: string, onEvent?: ReviewOptions["onEvent"]) {
    this.report = report;
    this.directory = directory;
    this.onEvent = onEvent;
  }

  task(name: TaskName): TaskRun {
    const task = this.report.tasks.find(item => item.name === name);
    if (!task) throw new Error(`Review task is not registered: ${name}`);
    return task;
  }

  publish(name: TaskName): Promise<void> {
    const snapshot = structuredClone(this.report);
    const next = this.publication.catch(() => undefined).then(() => saveTaskProgress(snapshot, this.directory, name));
    this.publication = next;
    return next;
  }

  skip(name: TaskName, finished = false): void {
    const task = this.task(name);
    task.status = "skipped";
    if (finished) task.finishedAt = new Date().toISOString();
  }

  skipPendingAnalysis(): void {
    for (const task of this.report.tasks) {
      if (task.name !== "report" && task.status === "pending") this.skip(task.name, true);
    }
  }

  async run<TResult extends TaskResult>(name: TaskName, operation: () => Promise<TResult>): Promise<TResult> {
    const task = this.task(name);
    const started = performance.now();
    task.status = "running";
    task.startedAt = new Date().toISOString();
    await this.publish(name);
    this.onEvent?.({ task: name, stage: name, kind: "started", message: `Task ${name}: started; report: ${path.join(this.directory, "tasks", taskFile(name))}` });
    try {
      const result = await operation();
      task.status = result.status;
      task.errors = result.errors;
      return result;
    } catch (error) {
      task.status = "incomplete";
      task.errors.push(errorMessage(error));
      throw error;
    } finally {
      task.durationMs = Math.round(performance.now() - started);
      task.finishedAt = new Date().toISOString();
      try { await this.publish(name); }
      catch (error) {
        task.status = "incomplete";
        task.errors.push(`Task report publication failed: ${errorMessage(error)}`);
      }
      this.onEvent?.({ task: name, stage: name, kind: "completed", message: `Task ${name}: ${task.status}; report: ${path.join(this.directory, "tasks", taskFile(name))}` });
    }
  }
}
