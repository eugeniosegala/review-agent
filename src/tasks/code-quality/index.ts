import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { mapSettledLimit } from "../../runtime/concurrency.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { CodeQualityResult, CodeQualityReview } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { buildCoverage, unique, validateExamination } from "../validation.ts";
import { inventorySource } from "../source-inventory.ts";
import { codeQualityPrompt } from "./prompt.ts";
import { validateQualityFindings } from "./evidence.ts";
import { repairQualityCitations } from "./repair.ts";
import { codeQualitySchema } from "./schema.ts";
import { consolidateQualityFindings } from "./consolidate.ts";

export async function runCodeQuality(context: TaskContext<"code-quality">): Promise<CodeQualityResult> {
  const result: CodeQualityResult = { status: "incomplete", findings: [], coverage: buildCoverage(context.review, { examinedFiles: [], skippedFiles: [] }), notes: [], errors: [], batches: [] };
  try {
    if (!context.review.changedFiles.length) return { ...result, status: "completed" };
    const inventory = await inventorySource(context.review);
    await writeFile(path.join(context.review.workspace, "review-inventory.json"), JSON.stringify(inventory, null, 2));
    if (inventory.literalIndexTruncated) result.notes.push("Literal hints were bounded; source batches still contain the full selected text and the agent can search related files.");
    const maximumBatches = context.options.maxCodeQualityBatches ?? 64;
    const selected = inventory.batches.slice(0, maximumBatches);
    if (inventory.batches.length > maximumBatches) result.errors.push(`The ${maximumBatches}-batch limit was reached; ${inventory.batches.length - maximumBatches} source batches were not reviewed.`);
    const max = context.options.maxQualityFindings ?? 5;
    const skill = await context.skill();
    const outcomes = await mapSettledLimit(selected, Math.min(context.options.perTaskConcurrency ?? 3, 4), async batch => {
      context.options.onEvent?.({ task: "code-quality", stage: "code-quality", kind: "progress", message: `code-quality: reviewing ${batch.id}/${inventory.batches.length} (${batch.files.length} file(s), ${batch.chunks.length} source chunk(s))` });
      const response = await context.invoke<CodeQualityReview>("code-quality",
        codeQualityPrompt(skill, context.review, max, batch, inventory), codeQualitySchema(batch.files, max, batch.chunks.map(chunk => chunk.id)), batch.id);
      unique(response.findings.map(finding => finding.id), "Code quality findings");
      unique(response.reviewedChunks, "Reviewed source chunks");
      validateExamination(response, batch.files);
      const validation = await repairQualityCitations(context, await validateQualityFindings(context.review, response.findings, batch.files), batch.files, batch.id);
      return { ...response, findings: validation.findings, notes: [...response.notes, ...validation.notes], validationErrors: validation.errors };

    }, context.options.signal);
    const ids = new Set<string>();
    for (const [index, outcome] of outcomes.entries()) {
      const batch = selected[index]!;
      const response = outcome.status === "fulfilled" ? outcome.value : undefined;
      const errors = outcome.status === "rejected" ? [errorMessage(outcome.reason)] : [...(response?.validationErrors ?? [])];
      if (response && batch.chunks.some(chunk => !response.reviewedChunks.includes(chunk.id))) errors.push("Some supplied source chunks were not examined.");
      if (response?.moreFindings) errors.push("Supported findings exceed this batch's response budget.");
      const complete = response && !errors.length && batch.files.every(file => response.examinedFiles.includes(file));
      result.batches.push({ id: batch.id, status: complete ? "completed" : "incomplete", domains: batch.domains, files: batch.files,
        suppliedChunks: batch.chunks.map(chunk => chunk.id), reviewedChunks: response?.reviewedChunks ?? [], errors });
      result.errors.push(...errors.map(error => `${batch.id}: ${error}`));
      if (!response) continue;
      result.notes.push(...response.notes);
      for (const finding of response.findings) {
        const key = JSON.stringify([finding.category, finding.locations.map(location => `${location.revision}:${location.path}:${location.line}`).sort()]);
        if (ids.has(finding.id)) finding.id = `quality_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
        ids.add(finding.id);
        result.findings.push(finding);
      }
    }
    const consolidated = consolidateQualityFindings(result.findings);
    result.findings = consolidated.findings;
    result.notes.push(...consolidated.notes);
    const skipped = new Map(inventory.skipped.map(item => [item.path, item.reason]));
    result.coverage = context.review.changedFiles.map(file => {
      const required = inventory.batches.filter(batch => batch.files.includes(file));
      const complete = !skipped.has(file) && required.length > 0 && required.every(batch => {
        const index = selected.indexOf(batch);
        const outcome = outcomes[index];
        return outcome?.status === "fulfilled" && outcome.value.examinedFiles.includes(file) &&
          batch.chunks.filter(chunk => chunk.path === file).every(chunk => outcome.value.reviewedChunks.includes(chunk.id));
      });
      return { path: file, applicable: !inventory.nonSourceFiles.includes(file), status: skipped.has(file) ? "skipped" : complete ? "examined" : "unreported",
        reason: skipped.get(file) ?? (complete ? "All source chunks were supplied and the agent reported examining them." : "One or more source chunks were omitted, failed, or not reported as examined.") };
    });
    result.notes = [...new Set(result.notes)];
    for (const entry of result.coverage.filter(entry => entry.status !== "examined" && !inventory.nonSourceFiles.includes(entry.path))) {
      result.errors.push(`${entry.path}: ${entry.reason}`);
    }
    result.status = !result.errors.length && result.coverage.every(entry => entry.status === "examined" || inventory.nonSourceFiles.includes(entry.path)) ? "completed" : "incomplete";
  } catch (error) { result.errors.push(errorMessage(error)); }
  return result;
}
