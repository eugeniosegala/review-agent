import type { ExecutionEvidence, ProcessResult, ReviewReport } from "../../shared/types.ts";

// Reporting summarizes validated outcomes. Probe code and raw logs remain available
// in the complete results and artifacts; repeating them here adds no new findings.
function processSummary(result: ProcessResult | null) {
  if (!result) return null;
  const { stdout: _stdout, stderr: _stderr, ...summary } = result;
  return summary;
}

function evidenceSummary(evidence: ExecutionEvidence | null) {
  if (!evidence) return null;
  return { ...evidence, result: processSummary(evidence.result) };
}

export function reportInput(report: ReviewReport) {
  const preflight = report.preflight;
  const adversarial = report.adversarial;
  return {
    status: report.status, tasks: report.tasks.filter(task => task.name !== "report"),
    instructions: report.instructions,
    preflight: preflight && { ...preflight,
      discovery: preflight.discovery && { ...preflight.discovery,
        requirements: preflight.discovery.requirements.map(({ check: _check, ...requirement }) => requirement) },
      checks: preflight.checks.map(check => ({ ...check, evidence: evidenceSummary(check.evidence) })),
      setup: preflight.setup?.map(setup => ({ ...setup, result: processSummary(setup.result) })),
    },
    codeQuality: report.codeQuality,
    adversarial: adversarial && { ...adversarial,
      generation: adversarial.generation && { ...adversarial.generation,
        experiments: adversarial.generation.experiments.map(({ files: _files, ...experiment }) => experiment) },
      evidence: adversarial.evidence.map(evidenceSummary),
    },
    errors: report.errors, limitations: report.limitations,
  };
}
