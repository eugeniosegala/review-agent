import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mapSettledLimit } from "../../runtime/concurrency.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { Hypothesis, Investigation } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { inventorySource } from "../source-inventory.ts";
import { validateInvestigation } from "./evidence.ts";
import { investigatePrompt } from "./prompts.ts";
import { investigationSchemaFor } from "./schemas.ts";

interface InvestigationOutcome {
  investigation: Investigation;
  errors: string[];
}

const severityOrder: Record<Hypothesis["severity"], number> = { high: 0, medium: 1, low: 2 };

function reserveId(hypothesis: Hypothesis, batchId: string, used: Set<string>): Hypothesis {
  if (!used.has(hypothesis.id)) { used.add(hypothesis.id); return hypothesis; }
  const stem = `${batchId}_${hypothesis.id}`.slice(0, 60);
  let candidate = stem;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${stem.slice(0, 63 - String(suffix).length)}_${suffix}`;
  used.add(candidate);
  return { ...hypothesis, id: candidate };
}

/** Examine bounded source domains concurrently, then deterministically enforce the global hypothesis budget. */
export async function investigateSource(context: TaskContext<"adversarial">, skill: string): Promise<InvestigationOutcome> {
  const inventory = await inventorySource(context.review, { indexRelatedLiterals: false });
  await writeFile(path.join(context.review.workspace, "investigation-inventory.json"), JSON.stringify(inventory, null, 2));
  const maximumBatches = context.options.maxAdversarialInvestigationBatches ?? 64;
  const selected = inventory.batches.slice(0, maximumBatches);
  const errors: string[] = [];
  if (inventory.batches.length > maximumBatches) {
    errors.push(`The ${maximumBatches}-batch adversarial investigation limit was reached; ${inventory.batches.length - maximumBatches} source batches were not examined.`);
  }
  if (!selected.length) {
    const investigation: Investigation = { hypotheses: [], examinedFiles: [], skippedFiles: inventory.skipped, notes: [] };
    if (!errors.length) validateInvestigation(investigation, context.review.changedFiles, context.options.maxHypotheses);
    return { investigation, errors };
  }

  const perBatchBudget = Math.max(1, Math.ceil(context.options.maxHypotheses / selected.length));
  const outcomes = await mapSettledLimit(selected, Math.min(context.options.perTaskConcurrency ?? 3, 4), async batch => {
    context.options.onEvent?.({ task: "adversarial", stage: "investigate", kind: "progress",
      message: `adversarial: investigating ${batch.id}/${inventory.batches.length} (${batch.files.length} file(s), ${batch.chunks.length} source chunk(s))` });
    const investigation = await context.invoke<Investigation>("investigate",
      investigatePrompt(skill, context.review, perBatchBudget, batch, context.review.changedFiles),
      investigationSchemaFor(batch.files, perBatchBudget), batch.id);
    validateInvestigation(investigation, batch.files, perBatchBudget);
    return investigation;
  }, context.options.signal);

  const candidates: { hypothesis: Hypothesis; batchId: string; order: number }[] = [];
  const examinedFiles: string[] = [];
  const skippedFiles = [...inventory.skipped];
  const notes: string[] = [];
  outcomes.forEach((outcome, index) => {
    const batch = selected[index]!;
    if (outcome.status === "rejected") {
      errors.push(`${batch.id}: ${errorMessage(outcome.reason)}`);
      return;
    }
    examinedFiles.push(...outcome.value.examinedFiles);
    skippedFiles.push(...outcome.value.skippedFiles);
    notes.push(...outcome.value.notes);
    outcome.value.hypotheses.forEach((hypothesis, position) => candidates.push({ hypothesis, batchId: batch.id, order: index * 1000 + position }));
  });
  candidates.sort((left, right) => severityOrder[left.hypothesis.severity] - severityOrder[right.hypothesis.severity] || left.order - right.order);
  const used = new Set<string>();
  const hypotheses = candidates.slice(0, context.options.maxHypotheses).map(candidate => reserveId(candidate.hypothesis, candidate.batchId, used));
  if (candidates.length > hypotheses.length) notes.push(`${candidates.length - hypotheses.length} lower-priority batch hypothesis candidate(s) were omitted by the global ${context.options.maxHypotheses}-hypothesis budget.`);
  const investigation: Investigation = {
    hypotheses,
    examinedFiles: [...new Set(examinedFiles)].sort(),
    skippedFiles: [...new Map(skippedFiles.map(item => [item.path, item])).values()].sort((a, b) => a.path.localeCompare(b.path)),
    notes: [...new Set(notes)],
  };
  if (!errors.length) validateInvestigation(investigation, context.review.changedFiles, context.options.maxHypotheses);
  return { investigation, errors };
}
