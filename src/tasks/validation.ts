import type { CoverageEntry, FileExamination, ReviewContext } from "../shared/types.ts";

export function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`);
}

export function validateExamination(examination: FileExamination, selected: string[], label = "Coverage"): void {
  const files = [...examination.examinedFiles, ...examination.skippedFiles.map(item => item.path)];
  unique(files, label);
  if (!files.every(file => selected.includes(file))) throw new Error(`${label} must use repository-relative selected paths`);
}

export function buildCoverage(context: ReviewContext, examination: FileExamination): CoverageEntry[] {
  return context.changedFiles.map(file => {
    const available = context.snapshots.base.files.includes(file) || context.snapshots.head.files.includes(file);
    const skip = examination.skippedFiles.find(item => item.path === file);
    const examined = examination.examinedFiles.includes(file);
    return {
      path: file,
      status: !available || skip ? "skipped" : examined ? "examined" : "unreported",
      reason: !available ? "Excluded from both snapshots" : skip?.reason ?? (examined ? "Agent reported examining this change" : "The agent did not report examining this change"),
    };
  });
}
