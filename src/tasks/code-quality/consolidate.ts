import type { CodeQualityFinding } from "../../shared/types.ts";

const categoryFamily: Record<CodeQualityFinding["category"], string> = {
  duplication: "structural-reuse",
  reuse: "structural-reuse",
  "duplicate-string": "literal-ownership",
  "hardcoded-constant": "literal-ownership",
  responsibility: "responsibility",
};

const severityRank = { low: 0, medium: 1, high: 2 } as const;
const stopWords = new Set("the a an and or is are was were be been being to of in on for from with by as at it its this that these those has have had same both each one into across between only currently independently shared existing owner owners repeated repeats duplicated duplicate centralize centralized module modules code implementation implementations definition definitions value values name finding".split(" "));

function sourceAnchor(location: CodeQualityFinding["locations"][number]): string {
  return `${location.path}:${location.line}:${location.snippet.trim().replace(/\s+/g, " ")}`;
}

function concepts(finding: CodeQualityFinding): Set<string> {
  const text = `${finding.title} ${finding.explanation} ${finding.recommendation}`.toLowerCase();
  return new Set((text.match(/[a-z0-9]+/g) ?? []).filter(token => token.length > 2 && !stopWords.has(token)));
}

function conceptSimilarity(left: CodeQualityFinding, right: CodeQualityFinding): number {
  const leftTokens = concepts(left);
  const rightTokens = concepts(right);
  const common = [...leftTokens].filter(token => rightTokens.has(token)).length;
  return common / new Set([...leftTokens, ...rightTokens]).size;
}

function overlaps(left: CodeQualityFinding, right: CodeQualityFinding): boolean {
  if (left.origin !== right.origin || categoryFamily[left.category] !== categoryFamily[right.category]) return false;
  const anchors = new Set(left.locations.map(sourceAnchor));
  const sharedAnchors = new Set(right.locations.map(sourceAnchor).filter(anchor => anchors.has(anchor))).size;
  return sharedAnchors >= 2 || (sharedAnchors === 1 && conceptSimilarity(left, right) >= 0.12);
}

function mergeLocations(left: CodeQualityFinding["locations"], right: CodeQualityFinding["locations"]) {
  const seen = new Set<string>();
  return [...left, ...right].filter(location => {
    const key = `${location.revision}:${sourceAnchor(location)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceScore(finding: CodeQualityFinding): number {
  return finding.locations.length * 2 + finding.changedFiles.length;
}

function mergeFinding(existing: CodeQualityFinding, candidate: CodeQualityFinding): void {
  const preferred = evidenceScore(candidate) > evidenceScore(existing) ? candidate : existing;
  existing.title = preferred.title;
  existing.category = preferred.category;
  existing.explanation = preferred.explanation;
  existing.recommendation = preferred.recommendation;
  if (severityRank[candidate.severity] > severityRank[existing.severity]) existing.severity = candidate.severity;
  existing.changedFiles = [...new Set([...existing.changedFiles, ...candidate.changedFiles])];
  existing.locations = mergeLocations(existing.locations, candidate.locations);
}

/** Collapse independently produced findings only when validated source evidence proves they overlap. */
export function consolidateQualityFindings(input: CodeQualityFinding[]): { findings: CodeQualityFinding[]; notes: string[] } {
  const findings: CodeQualityFinding[] = [];
  const mergedIds = new Map<string, string[]>();
  for (const candidate of input) {
    const index = findings.findIndex(finding => overlaps(finding, candidate));
    if (index < 0) {
      findings.push(structuredClone(candidate));
      continue;
    }
    let existingIndex = index;
    const existing = findings[existingIndex]!;
    mergeFinding(existing, candidate);
    const ids = mergedIds.get(existing.id) ?? [];
    ids.push(candidate.id);
    mergedIds.set(existing.id, ids);
    // A newly merged evidence set can connect two findings that arrived independently.
    for (;;) {
      const other = findings.findIndex((finding, candidateIndex) => candidateIndex !== existingIndex && overlaps(existing, finding));
      if (other < 0) break;
      const duplicate = findings.splice(other, 1)[0]!;
      if (other < existingIndex) existingIndex--;
      mergeFinding(existing, duplicate);
      ids.push(duplicate.id, ...(mergedIds.get(duplicate.id) ?? []));
      mergedIds.delete(duplicate.id);
    }
  }
  const notes = [...mergedIds].map(([kept, merged]) =>
    `Consolidated overlapping batch findings ${merged.map(id => `\`${id}\``).join(", ")} into \`${kept}\`; they cited the same validated source responsibility.`);
  return { findings, notes };
}
