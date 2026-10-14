import path from "node:path";
import type { CoverageEntry, ReviewReport, TaskName } from "../../shared/types.ts";

export const md = (value: string) => value.replace(/[\\`*_\[\]<>#|]/g, "\\$&").replaceAll("\n", " ");
export const fileLink = (directory: string, file: string) => encodeURI(path.relative(directory, file).split(path.sep).join("/")).replaceAll("(", "%28").replaceAll(")", "%29");

export function taskHeader(report: ReviewReport, task: TaskName, title: string): string[] {
  const duration = report.tasks.find(item => item.name === task)?.durationMs;
  return [`# ${title}`, "", `Task: **${report.tasks.find(item => item.name === task)?.status ?? "unavailable"}**. Review: **${report.status}**.`, "",
    ...(duration === undefined ? [] : [`Elapsed: ${(duration / 1000).toFixed(1)}s.`, ""]),
    `Run: \`${md(report.runId)}\`.`, "", `Base: \`${md(report.base)}\`  `, `Head: \`${md(report.head)}\``, "",
    ...(report.instructions ? [`Review request: ${md(report.instructions)}`, ""] : [])];
}

export function taskErrors(report: ReviewReport, task: TaskName, errors: string[] = []): string[] {
  const messages = [...new Set([...(report.tasks.find(item => item.name === task)?.errors ?? []), ...errors])];
  return messages.length ? ["", "## Errors", "", ...messages.map(error => `- ${md(error)}`), ""] : [];
}

export function examination(report: ReviewReport, task: "code-quality" | "adversarial", coverage: CoverageEntry[] = []): string[] {
  const lines = ["", "## Evaluated files", "", "This is agent-reported source examination, not measured test coverage.", "",
    "| File | Result | Reason |", "| --- | --- | --- |"];
  for (const file of report.reviewFiles) {
    const entry = coverage.find(item => item.path === file);
    const fallback = report.tasks.find(item => item.name === task)?.status === "skipped" ? "skipped" : "unreported";
    lines.push(`| ${md(file)} | ${entry?.applicable === false ? "not applicable" : entry?.status ?? fallback} | ${md(entry?.reason ?? "No examination reported")} |`);
  }
  if (!report.reviewFiles.length) lines.push("", "No source files in scope.");
  return lines;
}

export const taskFooter = ["", "[Review overview](../report.md) · [Complete structured results](../report.json)", ""];
