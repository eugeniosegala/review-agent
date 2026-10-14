import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { changedFiles, diff, resolveCommit, resolveRepository } from "./runtime/repository.ts";
import { diffSnapshots } from "./runtime/working-tree.ts";
import { prepareSnapshots } from "./runtime/snapshots.ts";
import { SourcePool } from "./runtime/source-pool.ts";
import { nodeToolchain } from "./runtime/node-toolchain.ts";
import { errorMessage } from "./shared/errors.ts";
import { createTaskContext } from "./tasks/context.ts";
import { runCodeQuality } from "./tasks/code-quality/index.ts";
import { runAdversarial } from "./tasks/adversarial/index.ts";
import { runPreflight } from "./tasks/preflight/index.ts";
import { runReporting } from "./tasks/report/index.ts";
import { saveReport } from "./tasks/report/render.ts";
import { ReviewTaskRunner } from "./review/task-runner.ts";
import { resolveReviewOptions } from "./review/options.ts";
import { createReviewReport } from "./review/report.ts";
import type { AgentBridge, ExperimentExecutor, ReviewContext, ReviewOptions, ReviewReport } from "./shared/types.ts";

/** Prepare pinned source, run independent analysis concurrently, then join for reporting. */
export async function review(options: ReviewOptions, bridge: AgentBridge, executor: ExperimentExecutor): Promise<{ report: ReviewReport; directory: string }> {
  const started = performance.now();
  const { analyses, reviewScope, perTaskConcurrency, ...selection } = resolveReviewOptions(options);
  const output = path.resolve(options.out);
  await mkdir(output, { recursive: true });
  const directory = options.runDirectory ? path.resolve(options.runDirectory) : await mkdtemp(path.join(output, "review-"));
  const workspace = path.join(directory, "artifacts", "context");
  await mkdir(workspace, { recursive: true });
  const report = createReviewReport(options, bridge, directory, { analyses, reviewScope, perTaskConcurrency, ...selection });
  await saveReport(structuredClone(report), directory);
  options.onEvent?.({ task: "report", stage: "report", kind: "progress",
    message: `Live report: ${path.join(directory, "report.md")} (task reports update as they complete)` });
  const tasks = new ReviewTaskRunner(report, directory, options.onEvent);
  let context: ReviewContext | undefined;
  let cleanupFailed = false;

  try {
    report.repo = await resolveRepository(options.repo);
    const captured = options.workingTree;
    if (captured) {
      report.base = captured.base.commit;
      report.head = captured.head.commit;
      report.changedFiles = captured.changedFiles.filter(file => !options.focus.length || options.focus.some(scope => file === scope || file.startsWith(`${scope}/`)));
      report.limitations.push("Reviewed frozen uncommitted working-tree contents against HEAD, including staged, unstaged, and non-ignored untracked files. Later edits are outside this review.");
    } else {
      report.base = await resolveCommit(report.repo, options.base);
      report.head = await resolveCommit(report.repo, options.head);
      report.changedFiles = await changedFiles(report.repo, report.base, report.head, options.focus);
    }
    const [sourceResult, diffResult] = await Promise.allSettled([
      prepareSnapshots(report.repo, { base: report.base, head: report.head }, directory, workspace,
        options.frozenSnapshots ?? (captured ? [captured.base, captured.head] : [])),
      captured ? diffSnapshots(captured.base, captured.head, report.changedFiles) : diff(report.repo, report.base, report.head, report.changedFiles),
    ]);
    if (sourceResult.status === "rejected") throw sourceResult.reason;
    if (diffResult.status === "rejected") throw diffResult.reason;
    for (const unused of sourceResult.value.discarded) await rm(unused, { recursive: true, force: true });
    const { base, head } = sourceResult.value.snapshots;
    const change = diffResult.value;
    report.snapshots = { base, head };
    const sourcePool = new SourcePool(path.join(directory, "artifacts", "execution-workspaces"), Math.max(2, perTaskConcurrency));
    report.storage = { frozenSourceCopies: sourceResult.value.count, ...sourcePool.stats };
    report.reviewFiles = reviewScope === "all" ? [...new Set([...base.files, ...head.files])].filter(file =>
      !options.focus.length || options.focus.some(scope => file === scope || file.startsWith(`${scope}/`))).sort() : report.changedFiles;
    report.diffTruncated = change.truncated;
    if (change.truncated) report.limitations.push("The diff was truncated to 250 KB; full exported source snapshots were available.");
    await writeFile(path.join(workspace, "change.diff"), change.text);
    const runtimes = executor.name === "current-runtime" ? await Promise.all([nodeToolchain(base.directory), nodeToolchain(head.directory)]) : undefined;
    const applicationRuntimes = runtimes ? { base: runtimes[0], head: runtimes[1] } : undefined;
    await writeFile(path.join(workspace, "executor-context.json"), JSON.stringify({ executor: executor.name, timeoutMs: options.experimentTimeoutMs,
      ...executor.context, applicationRuntimes, runtimeNote: "The service and application runtimes may differ. Generated node commands and child-process PATH use the selected application runtime." }));
    context = { repo: report.repo, base: report.base, head: report.head,
      sourcePool, snapshotTargets: sourceResult.value.targets, timings: report.timings, changedFiles: report.reviewFiles, snapshots: { base, head }, diffTruncated: change.truncated, workspace, directory };

    report.timings!.preparationMs = Math.round(performance.now() - started);
    const prepareAdversarial = async () => {
      if (context!.changedFiles.length) {
        try {
          await tasks.run("preflight", async () => {
            const result = await runPreflight(await createTaskContext(context!, options, bridge, executor, "preflight"));
            report.preflight = result;
            return result;
          });
        } catch (error) {
          report.preflight = { status: "incomplete", readiness: "blocked", discovery: null, checks: [], errors: [errorMessage(error)] };
          await tasks.publish("preflight");
        }
        const preflight = report.preflight!;
        context!.preflight = preflight;
        for (const setup of preflight.setup ?? []) {
          if (setup.dependencyRoot) (context!.dependencyRoots ??= {})[setup.revision] = setup.dependencyRoot;
        }
        if (preflight.status !== "completed" || preflight.readiness !== "ready") {
          const required = new Set(preflight.discovery?.requirements.filter(requirement => requirement.required).map(requirement => requirement.id));
          const blockers = preflight.checks.filter(check => required.has(check.requirementId) && check.outcome !== "available");
          const reasons = [...new Set(blockers.map(check => `${check.requirementId} (${check.revision}): ${check.reason}`))];
          const message = `Preflight could not verify required prerequisites.${reasons.length ? " " + reasons.join("; ") : " " + preflight.errors.join("; ")}`;
          options.onEvent?.({ task: "preflight", stage: "preflight", kind: "progress", message: `${message} Preflight is advisory; attempting the selected adversarial review.` });
          report.limitations.push("Preflight could not verify all prerequisites. Adversarial testing was attempted; each probe's execution evidence determines whether it ran successfully.");
        }
      } else tasks.skip("preflight");
    };
    const adversarialWithPreflight = async () => {
      const preparation = prepareAdversarial();
      // Always drain preparation, including when creating an analysis workspace fails.
      const outcomes = await Promise.allSettled([
        preparation,
        tasks.run("adversarial", async () => {
          const task = await createTaskContext(context!, options, bridge, executor, "adversarial");
          const result = await runAdversarial(task, async () => {
            await preparation;
            task.review.preflight = context!.preflight;
            task.review.dependencyRoots = context!.dependencyRoots;
            if (task.review.preflight) await writeFile(path.join(task.review.workspace, "preflight-context.json"), JSON.stringify(task.review.preflight, null, 2));
          });
          report.adversarial = result;
          return result;
        }),
      ]);
      if (outcomes[1]!.status === "rejected") throw outcomes[1]!.reason;
      if (outcomes[0]!.status === "rejected") throw outcomes[0]!.reason;
      return outcomes[1]!.value;
    };

    // Separate task metadata workspaces share frozen source; settle both before any report reads their outputs.
    const [quality, adversarial] = await Promise.allSettled([
      analyses.includes("code-quality") ? tasks.run("code-quality", async () => {
        const result = await runCodeQuality(await createTaskContext(context!, options, bridge, executor, "code-quality"));
        report.codeQuality = result;
        return result;
      }) : Promise.resolve(null),
      analyses.includes("adversarial") ? adversarialWithPreflight() : Promise.resolve(null),
    ]);
    if (quality.status === "fulfilled") report.codeQuality = quality.value;
    if (adversarial.status === "fulfilled") report.adversarial = adversarial.value;
  } catch (error) {
    if (!context) report.timings!.preparationMs = Math.round(performance.now() - started);
    report.errors.push(errorMessage(error));
    tasks.skipPendingAnalysis();
  } finally {
    if (context?.sourcePool) {
      try { await context.sourcePool.close(); }
      catch (error) { cleanupFailed = true; report.errors.push(`Source workspace cleanup: ${errorMessage(error)}`); }
      report.storage = { frozenSourceCopies: report.storage!.frozenSourceCopies, ...context.sourcePool.stats };
    }
  }

  report.errors.push(...report.tasks.filter(task => task.name !== "report").flatMap(task => task.errors.map(error => `${task.name}: ${error}`)));
  const analysisStatus: "completed" | "incomplete" = context && !cleanupFailed && analyses.every(name => report.tasks.find(task => task.name === name)?.status === "completed") ? "completed" : "incomplete";

  // Task 3: summarize only the task outputs; preserve original findings and evidence.
  try {
    await tasks.run("report", async () => {
      const reportingInput = { ...report, status: analysisStatus };
      const result = await runReporting(context ? await createTaskContext(context, options, bridge, executor, "report") : undefined, reportingInput);
      report.reporting = result;
      report.status = analysisStatus === "completed" && result.status === "completed" ? "completed" : "incomplete";
      return result;
    });
  } catch (error) {
    report.reporting = { status: "incomplete", narrative: null, errors: [errorMessage(error)] };
    report.status = "incomplete";
    await tasks.publish("report");
  }
  const reporting = report.reporting!;
  report.errors.push(...reporting.errors.map(error => `report: ${error}`));
  if (reporting.status !== "completed") report.status = "incomplete";
  report.finishedAt = new Date().toISOString();
  report.timings!.totalMs = Math.round(performance.now() - started);
  await saveReport(report, directory);
  return { report, directory };
}
