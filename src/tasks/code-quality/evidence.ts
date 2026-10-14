import { readFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import type { CodeQualityFinding, ReviewContext } from "../../shared/types.ts";

export interface QualityValidation {
  findings: CodeQualityFinding[];
  rejected: { finding: CodeQualityFinding; reason: string }[];
  notes: string[];
}

/** Reject individual candidates; never discard unrelated findings or examination receipts. */
export async function validateQualityFindings(context: ReviewContext, candidates: CodeQualityFinding[], files: string[]): Promise<QualityValidation> {
  const result: QualityValidation = { findings: [], rejected: [], notes: [] };
  const sources = new Map<string, Promise<string[]>>();
  for (const candidate of candidates) {
    const finding = structuredClone(candidate);
    const corrections: string[] = [];
    try {
      if (!finding.changedFiles.every(file => files.includes(file))) throw new Error("Quality finding references a path outside the selected batch scope");
      if (!finding.locations.some(location => finding.changedFiles.includes(location.path))) throw new Error("Quality finding has no source evidence in its selected scope");
      const verifiedLocations: CodeQualityFinding["locations"] = [];
      for (const location of finding.locations) {
        const snapshot = context.snapshots[location.revision];
        if (!snapshot.files.includes(location.path)) throw new Error(`Quality location is not an exported source file: ${location.path}`);
        const key = `${location.revision}:${location.path}`;
        if (!sources.has(key)) sources.set(key, readFile(path.join(snapshot.directory, location.path), "utf8").then(source => source.split("\n")));
        const lines = await sources.get(key)!;
        const snippet = location.snippet.trim();
        if (!snippet) throw new Error("A blank source line cannot substantiate a quality finding");
        if (lines[location.line - 1]?.trim() !== snippet) {
          const matches = lines.flatMap((line, index) => line.trim() === snippet ? [index + 1] : []);
          // Relocate only an exact, unique full-line quote. Never fuzzy-match or guess.
          if (matches.length > 1) {
            corrections.push(`${finding.id}: dropped an ambiguous quote at ${location.path}:${location.line}; ${matches.length} source lines match exactly.`);
            continue;
          }
          if (matches.length === 0) throw new Error(`Quality finding ${finding.id} quotes an invalid source line: ${location.path}:${location.line}`);
          corrections.push(`${finding.id}: verified the unique exact quote at ${location.path}:${matches[0]} (agent supplied line ${location.line}).`);
          location.line = matches[0]!;
        }
        verifiedLocations.push(location);
      }
      finding.locations = verifiedLocations;
      if (!finding.locations.some(location => finding.changedFiles.includes(location.path))) throw new Error("Quality finding has no unambiguous source evidence in its selected scope");
      const duplicated = (["base", "head"] as const).some(revision => new Set(finding.locations.filter(location => location.revision === revision)
        .map(location => `${location.path}:${location.line}`)).size >= 2);
      if (["duplication", "duplicate-string"].includes(finding.category) && !duplicated) throw new Error("Duplication findings require two distinct code locations within one revision");
      result.findings.push(finding);
      result.notes.push(...corrections);
    } catch (error) { result.rejected.push({ finding: candidate, reason: errorMessage(error) }); }
  }
  return result;
}
