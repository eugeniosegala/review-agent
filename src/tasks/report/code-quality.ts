import path from "node:path";
import type { ReviewReport } from "../../shared/types.ts";
import { examination, fileLink, md, taskErrors, taskFooter, taskHeader } from "./markdown.ts";

export function renderCodeQuality(report: ReviewReport, directory: string): string {
  const result = report.codeQuality;
  const status = report.tasks.find(item => item.name === "code-quality")?.status;
  const lines = taskHeader(report, "code-quality", "Code quality");
  lines.push("Advisory recommendations about reuse, duplication, and responsibility boundaries.", "");
  if (result) {
    lines.push(`Source examination: ${result.coverage.filter(entry => entry.applicable !== false && entry.status === "examined").length}/${result.coverage.filter(entry => entry.applicable !== false).length} selected files; ${result.batches.filter(batch => batch.status === "completed").length}/${result.batches.length} completed batches.`, "");
    if (result.batches.length) {
      lines.push("## Source batches", "", "| Batch | Source domains | Files | Status | Reviewed chunks | Supplied chunks |", "| --- | --- | ---: | --- | ---: | ---: |");
      for (const batch of result.batches) lines.push(`| ${batch.id} | ${batch.domains.map(md).join(", ")} | ${batch.files.length} | ${batch.status} | ${batch.reviewedChunks.length} | ${batch.suppliedChunks.length} |`);
      lines.push("", "[Source inventory and supplied batches](../artifacts/tasks/code-quality/context/review-inventory.json)", "");
    }
  }
  if (!result?.findings.length) lines.push(status === "running" ? "Code-quality analysis is in progress." : status === "pending" ? "Code-quality analysis is pending." : status === "skipped" ? "Code-quality analysis was skipped." : "No supported code-quality recommendations were produced.");
  for (const finding of result?.findings ?? []) {
    lines.push("", `## ${md(finding.title)}`, "", `ID: \`${md(finding.id)}\` · ${finding.category} · ${finding.origin} · ${finding.severity} severity`, "",
      md(finding.explanation), "", `Recommendation: ${md(finding.recommendation)}`, "");
    for (const location of finding.locations) {
      const snapshot = report.snapshots?.[location.revision];
      if (snapshot) lines.push(`- ${location.revision} / ${md(location.path)}:${location.line} — [source](${fileLink(directory, path.join(snapshot.directory, location.path))}).`);
    }
  }
  if (result?.notes.length) lines.push("", "## Notes", "", ...result.notes.map(note => `- ${md(note)}`));
  lines.push(...examination(report, "code-quality", result?.coverage), ...taskErrors(report, "code-quality", result?.errors), ...taskFooter);
  return lines.join("\n");
}
