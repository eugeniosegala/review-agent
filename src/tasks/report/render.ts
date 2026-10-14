import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewReport, TaskName } from "../../shared/types.ts";
import { renderAdversarial } from "./adversarial.ts";
import { renderCodeQuality } from "./code-quality.ts";
import { renderPreflight } from "./preflight.ts";
import { md, taskErrors, taskFooter, taskHeader } from "./markdown.ts";

const taskTitles: Record<TaskName, string> = { preflight: "Dependency preflight", "code-quality": "Code quality", adversarial: "Adversarial testing", report: "Report generation" };
export const taskFile = (task: TaskName) => `${task === "report" ? "report-generation" : task}.md`;

function narrative(report: ReviewReport, prefix: string): string[] {
  const result = report.reporting?.narrative;
  if (!result) return [report.status === "running"
    ? "The final summary is pending. Completed task reports are available above while remaining work continues."
    : "The reporting task produced no validated narrative. Individual task reports preserve the available results."];
  return [md(result.summary), "", ...result.priorities.map(priority => `- [${priority.source} / ${md(priority.findingId)}](${prefix}${priority.source}.md): ${md(priority.reason)}`),
    ...result.notes.map(note => `- ${md(note)}`)];
}

function renderReporting(report: ReviewReport): string {
  return [...taskHeader(report, "report", "Report generation"), "## Evaluated files", "",
    "This task evaluates validated task outputs and does not inspect repository source files.", "", ...narrative(report, ""),
    ...taskErrors(report, "report", report.reporting?.errors), ...taskFooter].join("\n");
}

function renderTask(report: ReviewReport, task: TaskName, tasksDirectory: string): string {
  switch (task) {
    case "preflight": return renderPreflight(report, tasksDirectory);
    case "code-quality": return renderCodeQuality(report, tasksDirectory);
    case "adversarial": return renderAdversarial(report, tasksDirectory);
    case "report": return renderReporting(report);
  }
}

async function atomicWriteFile(filename: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function renderReport(report: ReviewReport): string {
  const lines = ["# Review overview", "", `Workflow: **${report.status}**. Bridge: ${md(report.bridge)}.`, "",
    `Base: \`${md(report.base)}\`  `, `Head: \`${md(report.head)}\``, "",
    ...(report.instructions ? [`Review request: ${md(report.instructions)}`, ""] : []),
    `Scope: **${report.reviewScope}**, ${report.reviewFiles.length} selected file(s); comparison: **${report.comparison}**.`, "",
    "## Task reports", "", "| Task | Status | Time | Report |", "| --- | --- | --- | --- |"];
  for (const task of report.tasks) lines.push(`| ${taskTitles[task.name]} | ${task.status} | ${task.durationMs === undefined ? "—" : `${(task.durationMs / 1000).toFixed(1)}s`} | [Open report](tasks/${taskFile(task.name)}) |`);
  if (report.storage) lines.push("", `Source storage: ${report.storage.frozenSourceCopies} retained frozen source(s); ${report.storage.executionCopiesCreated} execution copy/copies created, ${report.storage.executionCopiesReused} reuse(s), at most ${report.storage.peakExecutionCopies} execution copies retained concurrently. Temporary execution copies are removed after analysis.`);
  if (report.timings) {
    lines.push("", `Review time: **${(report.timings.totalMs / 1000).toFixed(1)}s**; source preparation: ${(report.timings.preparationMs / 1000).toFixed(1)}s. Request planning and report-file saving are measured separately by the CLI. Tasks overlap, so their times do not add up to wall time.`, "",
      "| Agent stage | Time |", "| --- | --- |");
    for (const call of report.timings.agentCalls) lines.push(`| ${call.task}/${call.stage}${call.artifactId ? ` / ${md(call.artifactId)}` : ""} | ${(call.durationMs / 1000).toFixed(1)}s |`);
  }
  lines.push("", "## Summary", "", ...narrative(report, "tasks/"), "",
    `Code quality: ${report.codeQuality?.findings.length ?? 0} recommendation(s).`, "",
    `Adversarial: ${report.adversarial?.findings.filter(finding => finding.status === "reproduced_regression").length ?? 0} reproduced regression(s).`, "");
  if (report.preflight) lines.push(`Dependency readiness: **${report.preflight.readiness}**. See the [preflight report](tasks/preflight.md).`, "");
  if (report.errors.length) lines.push("## Errors", "", ...report.errors.map(error => `- ${md(error)}`), "");
  lines.push("## Limitations", "", ...report.limitations.map(limitation => `- ${md(limitation)}`), "",
    "[Complete structured results](report.json). Task reports link to source snapshots, probes, and logs under artifacts/.", "");
  return lines.join("\n");
}

export async function saveReport(report: ReviewReport, directory: string): Promise<void> {
  const tasksDirectory = path.join(directory, "tasks");
  await mkdir(tasksDirectory, { recursive: true });
  await Promise.all([
    atomicWriteFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2)),
    atomicWriteFile(path.join(directory, "report.md"), renderReport(report)),
    ...report.tasks.map(task => atomicWriteFile(path.join(tasksDirectory, taskFile(task.name)), renderTask(report, task.name, tasksDirectory))),
  ]);
}

/** Publish one task and the live overview without exposing partially-written files. */
export async function saveTaskProgress(report: ReviewReport, directory: string, task: TaskName): Promise<void> {
  const tasksDirectory = path.join(directory, "tasks");
  await mkdir(tasksDirectory, { recursive: true });
  await Promise.all([
    atomicWriteFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2)),
    atomicWriteFile(path.join(directory, "report.md"), renderReport(report)),
    atomicWriteFile(path.join(tasksDirectory, taskFile(task)), renderTask(report, task, tasksDirectory)),
  ]);
}
