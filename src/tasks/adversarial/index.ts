import { writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import type { AdversarialResult, Generation } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { buildCoverage } from "../validation.ts";
import { classifyFinding, validateGeneration } from "./evidence.ts";
import { generatePrompt, repairGenerationPrompt } from "./prompts.ts";
import { generationSchemaFor } from "./schemas.ts";
import { finalizeAdversarial } from "./result.ts";
import { executeExperiments } from "./execute.ts";
import { assessHypotheses } from "./assessment.ts";
import { investigateSource } from "./investigate.ts";

export async function runAdversarial(context: TaskContext<"adversarial">, prepareExecution?: () => Promise<void>): Promise<AdversarialResult> {
  const result: AdversarialResult = {
    status: "incomplete", investigation: null, generation: null, evidence: [], findings: [],
    coverage: buildCoverage(context.review, { examinedFiles: [], skippedFiles: [] }), errors: [],
  };
  try {
    const skill = await context.skill();
    if (!context.review.changedFiles.length) {
      result.investigation = { hypotheses: [], examinedFiles: [], skippedFiles: [], notes: ["No source files in the selected scope."] };
    } else {
      const investigation = await investigateSource(context, skill);
      result.investigation = investigation.investigation;
      result.errors.push(...investigation.errors);
    }
    result.coverage = buildCoverage(context.review, result.investigation);
    // Investigation reads source only. Setup can run concurrently, but generation and
    // execution must see the final diagnostics and prepared dependency environments.
    if (prepareExecution) {
      const prepare = prepareExecution;
      prepareExecution = undefined;
      await prepare();
    }
    const hypotheses = result.investigation.hypotheses;
    if (hypotheses.length) {
      const maximumExperiments = context.options.maxExperimentsPerHypothesis ?? 1;
      result.generation = await context.invoke<Generation>("generate", generatePrompt(skill, hypotheses, maximumExperiments), generationSchemaFor(hypotheses, maximumExperiments));
      validateGeneration(result.generation, hypotheses, maximumExperiments);
      let execution = await executeExperiments(context, result.generation.experiments);
      result.evidence = execution.evidence;
      for (let attempt = 1; attempt <= (context.options.probeRepairAttempts ?? 0); attempt++) {
        const failed = hypotheses.filter(hypothesis => {
          const experiments = result.generation!.experiments.filter(item => item.hypothesisId === hypothesis.id);
          if (!experiments.length) return false;
          const evidence = result.evidence.filter(item => item.hypothesisId === hypothesis.id);
          return evidence.length < experiments.length * 2 || evidence.every(item => item.outcome === "error");
        });
        if (!failed.length) break;
        const failedIds = new Set(failed.map(item => item.id));
        const failedExperiments = result.generation.experiments.filter(item => failedIds.has(item.hypothesisId));
        try {
          context.options.onEvent?.({ task: "adversarial", stage: "generate", kind: "progress",
            message: `adversarial: repairing probes for ${failed.length} hypothesis/hypotheses (attempt ${attempt})` });
          const repair = await context.invoke<Generation>("generate",
            repairGenerationPrompt(skill, failed, maximumExperiments, { experiments: failedExperiments,
              skipped: result.generation.skipped.filter(item => failedIds.has(item.hypothesisId)) },
            result.evidence.filter(item => failedIds.has(item.hypothesisId)), execution.errors),
            generationSchemaFor(failed, maximumExperiments), `probe-repair-${attempt}`);
          validateGeneration(repair, failed, maximumExperiments);
          const merged: Generation = {
            experiments: [...result.generation.experiments.filter(item => !failedIds.has(item.hypothesisId)), ...repair.experiments],
            skipped: [...result.generation.skipped.filter(item => !failedIds.has(item.hypothesisId)), ...repair.skipped],
          };
          validateGeneration(merged, hypotheses, maximumExperiments);
          const repairedExecution = await executeExperiments(context, repair.experiments,
            `artifacts/tasks/adversarial/experiments-repair-${attempt}`);
          const failedExperimentIds = new Set(failedExperiments.map(item => item.id));
          execution = {
            evidence: [...result.evidence.filter(item => !failedIds.has(item.hypothesisId)), ...repairedExecution.evidence],
            errors: [...execution.errors.filter(error => ![...failedExperimentIds].some(id => error.startsWith(`${id}:`))), ...repairedExecution.errors],
          };
          result.generation = merged;
          result.evidence = execution.evidence;
          result.investigation.notes.push(`Regenerated probes for ${failed.map(item => item.id).join(", ")} after setup/runtime-only evidence (attempt ${attempt}).`);
        } catch (error) {
          result.errors.push(`Probe repair attempt ${attempt} failed: ${errorMessage(error)}`);
          break;
        }
      }
      result.errors.push(...execution.errors);
      await writeFile(path.join(context.review.workspace, "assessment-context.json"), JSON.stringify({ hypotheses, generation: result.generation, evidence: result.evidence, executionErrors: execution.errors }, null, 2));
      const { assessment, errors } = await assessHypotheses(context, skill, hypotheses, result);
      result.errors.push(...errors);
      result.findings = hypotheses.map(hypothesis => classifyFinding(hypothesis,
        assessment.findings.find(f => f.hypothesisId === hypothesis.id), result.evidence,
        result.generation?.skipped.find(s => s.hypothesisId === hypothesis.id)?.reason));
    }

  } catch (error) {
    result.errors.push(errorMessage(error));
    result.findings = result.investigation?.hypotheses.map(h => classifyFinding(h, undefined, result.evidence)) ?? [];
  }
  // Drain setup even if investigation fails, before the reporting task reads results.
  if (prepareExecution) {
    try { await prepareExecution(); } catch (error) { result.errors.push(errorMessage(error)); }
  }
  finalizeAdversarial(result);
  return result;
}
