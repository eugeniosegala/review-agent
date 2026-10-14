import { nonSourceReason } from "../../runtime/review-files.ts";
import type { AdversarialResult } from "../../shared/types.ts";

const examinationPrefix = "Source examination incomplete:";

/** Separate source applicability from actual examination and probe execution. */
export function finalizeAdversarial(result: AdversarialResult): void {
  result.coverage = result.coverage.map(entry => {
    const reason = nonSourceReason(entry.path);
    return reason ? { ...entry, applicable: false, reason: entry.reason.startsWith(reason) ? entry.reason : `${reason} ${entry.reason}` } : { ...entry, applicable: true };
  });
  const source = result.coverage.filter(entry => entry.applicable !== false);
  const missing = source.filter(entry => entry.status !== "examined");
  result.errors = result.errors.filter(error => !error.startsWith(examinationPrefix));
  if (missing.length) result.errors.push(`${examinationPrefix} ${source.length - missing.length}/${source.length} selected source paths examined; ${missing.filter(item => item.status === "skipped").length} skipped and ${missing.filter(item => item.status === "unreported").length} unreported. See the adversarial report for per-file reasons. Preflight and probe execution are separate from examination coverage.`);
  for (const finding of result.findings.filter(item => item.status === "inconclusive")) {
    const message = `${finding.hypothesis.id}: ${finding.explanation}`;
    if (!result.errors.includes(message)) result.errors.push(message);
  }
  result.status = result.errors.length || missing.length || result.findings.some(item => item.status === "inconclusive") ||
    result.evidence.some(item => item.outcome === "error") ? "incomplete" : "completed";
}
