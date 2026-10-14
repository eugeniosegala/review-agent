import type { ReviewReport } from "../../shared/types.ts";
import { examination, fileLink, md, taskErrors, taskFooter, taskHeader } from "./markdown.ts";

export function renderAdversarial(report: ReviewReport, directory: string): string {
  const result = report.adversarial;
  const status = report.tasks.find(item => item.name === "adversarial")?.status;
  const lines = taskHeader(report, "adversarial", "Adversarial testing");
  lines.push("Behavioral findings retain their deterministic evidence status. Passing probes establish only what was tested.", "");
  if (!result?.findings.length) lines.push(status === "running" ? "Adversarial analysis is in progress." : status === "pending" ? "Adversarial analysis is pending." : status === "skipped" ? "Adversarial analysis was skipped." : "No behavioral findings were produced.");
  if (report.preflight?.readiness === "blocked") lines.push("", "Preflight could not verify all prerequisites. Its checks are advisory; the probe results below show what actually executed. See the [prerequisite results](preflight.md).");
  for (const finding of result?.findings ?? []) {
    lines.push("", `## ${md(finding.hypothesis.title)}`, "", `ID: \`${md(finding.hypothesis.id)}\` · **${finding.status}** · ${finding.hypothesis.severity} severity · ${finding.confidence} confidence`, "",
      md(finding.explanation), "", `Expected invariant: ${md(finding.hypothesis.invariant)}`, "",
      `Expectation source: ${md(finding.hypothesis.expectationSource)}`, "", `Assessment: ${md(finding.expectationJustification)}`, "");
    for (const id of finding.evidenceIds) {
      const evidence = result!.evidence.find(item => item.id === id);
      if (!evidence) continue;
      lines.push(`- ${md(id)}: **${evidence.outcome}**, exit ${evidence.result.exitCode}, ${evidence.result.durationMs} ms; [stdout](${fileLink(directory, evidence.stdoutPath)}) · [stderr](${fileLink(directory, evidence.stderrPath)}).`);
      if (evidence.observation) lines.push(`  Expected: ${md(evidence.observation.expected)}. Observed: ${md(evidence.observation.actual)}.`);
    }
  }
  if (result?.investigation?.notes.length) lines.push("", "## Investigation notes", "", ...result.investigation.notes.map(note => `- ${md(note)}`));
  if (result?.generation?.skipped.length) lines.push("", "## Probes not generated", "", ...result.generation.skipped.map(item => `- ${md(item.hypothesisId)}: ${md(item.reason)}`));
  if (result?.evidence.length) {
    lines.push("", "## Executed probes", "", "| Evidence | Revision | Result | Logs |", "| --- | --- | --- | --- |");
    for (const evidence of result.evidence) lines.push(`| ${md(evidence.id)} | ${evidence.revision} | ${evidence.outcome} | [stdout](${fileLink(directory, evidence.stdoutPath)}) · [stderr](${fileLink(directory, evidence.stderrPath)}) |`);
  }
  lines.push(...examination(report, "adversarial", result?.coverage), ...taskErrors(report, "adversarial", result?.errors), ...taskFooter);
  return lines.join("\n");
}
