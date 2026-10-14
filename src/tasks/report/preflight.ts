import type { ReviewReport } from "../../shared/types.ts";
import { fileLink, md, taskErrors, taskFooter, taskHeader } from "./markdown.ts";

function evaluatedFiles(report: ReviewReport): string[] {
  const discovery = report.preflight?.discovery;
  if (!discovery) return [];
  const citations = new Map<string, string[]>();
  for (const requirement of discovery.requirements) {
    for (const source of requirement.sources) {
      const labels = citations.get(source.path) ?? [];
      labels.push(`${requirement.id} (${source.revision})`);
      citations.set(source.path, labels);
    }
  }
  const skipped = new Map(discovery.skippedFiles.map(file => [file.path, file.reason]));
  const paths = [...new Set([...discovery.examinedFiles, ...discovery.skippedFiles.map(file => file.path)])].sort();
  const lines = ["", "## Evaluated files", "",
    "This receipt lists repository source files inspected during environment discovery. It is not measured runtime coverage.", "",
    "| File | Result | Evidence or reason |", "| --- | --- | --- |"];
  for (const file of paths) {
    const sources = citations.get(file);
    lines.push(`| ${md(file)} | ${skipped.has(file) ? "skipped" : "examined"} | ${md(sources?.length ? `Prerequisite source: ${[...new Set(sources)].join(", ")}` : skipped.get(file) ?? "Agent reported inspecting this source")} |`);
  }
  if (!paths.length) lines.push("", "No repository source files were reported as inspected.");
  return lines;
}

export function renderPreflight(report: ReviewReport, directory: string): string {
  const result = report.preflight;
  const status = report.tasks.find(item => item.name === "preflight")?.status;
  const lines = taskHeader(report, "preflight", "Dependency preflight");
  if (!result) lines.push(status === "running" ? "Dependency preflight is in progress." : status === "pending" ? "Dependency preflight is pending." : "Dependency preflight was not run.");
  else {
    lines.push(`Readiness: **${result.readiness}**.`, "");
    lines.push("Preflight prepares the environment and provides advisory diagnostics. Adversarial attempts continue when setup is incomplete.", "");
    if (result.setup?.length) {
      lines.push("## Dependency setup", "", "| Revision | Status | Outcome |", "| --- | --- | --- |");
      for (const setup of result.setup) lines.push(`| ${setup.revision} | ${setup.status} | ${md(setup.reason)} |`);
      for (const setup of result.setup.filter(item => item.result)) lines.push("", `${setup.revision}: [installer stdout](${fileLink(directory, setup.directory + "/stdout.log")}) · [installer stderr](${fileLink(directory, setup.directory + "/stderr.log")})`);
      lines.push("");
    } else lines.push("No dependency installation was needed or attempted.", "");
    if (result.discovery) {
      lines.push(md(result.discovery.approach), "", "| Prerequisite | Revision | Required | Result |", "| --- | --- | --- | --- |");
      for (const check of result.checks) {
        const requirement = result.discovery.requirements.find(item => item.id === check.requirementId)!;
        lines.push(`| ${md(requirement.description)} | ${check.revision} | ${requirement.required ? "yes" : "no"} | ${check.outcome} |`);
      }
      for (const check of result.checks) {
        const requirement = result.discovery.requirements.find(item => item.id === check.requirementId)!;
        lines.push("", `## ${md(requirement.description)} (${check.revision})`, "",
          `**${check.outcome}** · ${requirement.required ? "required" : "optional"}`, "", md(check.reason));
        if (check.evidence) {
          const evidence = check.evidence;
          if (evidence.observation) lines.push("", `Expected: ${md(evidence.observation.expected)}.`, "", `Observed: ${md(evidence.observation.actual)}.`);
          lines.push("", `Exit: ${evidence.result.exitCode ?? evidence.result.signal ?? "unknown"}; duration: ${evidence.result.durationMs} ms.`, "",
            `[stdout](${fileLink(directory, evidence.stdoutPath)}) · [stderr](${fileLink(directory, evidence.stderrPath)})`);
        }
        if (check.outcome !== "available") lines.push("", `Setup: ${md(requirement.remediation)}`);
      }
      if (result.discovery.notes.length) lines.push("", "## Notes", "", ...result.discovery.notes.map(note => `- ${md(note)}`));
    }
    lines.push(...evaluatedFiles(report));
  }
  lines.push(...taskErrors(report, "preflight", result?.errors), ...taskFooter);
  return lines.join("\n");
}
