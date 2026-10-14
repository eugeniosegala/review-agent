import { writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import type { ReportingResult, ReportNarrative, ReviewReport } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { unique } from "../validation.ts";
import { reportPrompt } from "./prompt.ts";
import { reportSchema } from "./schema.ts";
import { reportInput } from "./input.ts";

export async function runReporting(context: TaskContext<"report"> | undefined, report: ReviewReport): Promise<ReportingResult> {
  const result: ReportingResult = { status: "incomplete", narrative: null, errors: [] };
  try {
    if (!context) throw new Error("Analysis context was not prepared; the deterministic report preserves available results.");
    await writeFile(path.join(context.review.workspace, "report-input.json"), JSON.stringify(reportInput(report), null, 2));
    const narrative = await context.invoke<ReportNarrative>("report", reportPrompt(await context.skill(), report), reportSchema);
    unique(narrative.priorities.map(p => `${p.source}:${p.findingId}`), "Report priorities");
    for (const priority of narrative.priorities) {
      const exists = priority.source === "code-quality"
        ? report.codeQuality?.findings.some(f => f.id === priority.findingId)
        : report.adversarial?.findings.some(f => f.hypothesis.id === priority.findingId);
      if (!exists) throw new Error(`Report references a nonexistent ${priority.source} finding: ${priority.findingId}`);
    }
    result.narrative = narrative;
    result.status = "completed";
  } catch (error) { result.errors.push(errorMessage(error)); }
  return result;
}
