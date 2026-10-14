import type { ReviewReport } from "../../shared/types.ts";

export function reportPrompt(skill: string, report: ReviewReport): string {
  return `${skill}

Task: REPORT. Read report-input.json, which contains preflight readiness, separate task outputs, and statuses.
It preserves validated findings, observations, errors, and coverage. Raw logs and probe code are
omitted from this summary input; complete evidence remains in the structured results and linked logs.
Return a concise summary, priorities referencing existing finding IDs, and notes using the supplied schema.
Do not read source to discover new issues, generate tests, execute code, or change verified finding statuses.
Keep quality recommendations separate from reproduced defects, pre-existing issues, and inconclusive probes.
Describe unverified prerequisites as advisory setup diagnostics, never application defects.
Preflight does not block adversarial attempts. Use actual probe results to state what ran or failed.
If a task failed or coverage is incomplete, preserve that uncertainty. The renderer will include all original
findings and evidence unchanged, even when you choose not to prioritize a particular finding.
Base: ${report.base}; head: ${report.head}. Analysis workflow status: ${report.status}.
`;
}
