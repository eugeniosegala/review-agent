import type { Experiment, PreflightDiscovery, PreflightResult } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { executeTaskProbes } from "../probes.ts";

export async function verifyPrerequisites(context: TaskContext<"preflight">, discovery: PreflightDiscovery, afterSetup = false, artifactGroup?: string): Promise<Pick<PreflightResult, "checks" | "errors" | "readiness">> {
  const experiments: Experiment[] = discovery.requirements.flatMap(requirement => requirement.check ? [{
    id: `preflight_${requirement.id}`, hypothesisId: requirement.id, description: requirement.description,
    ...requirement.check,
  }] : []);
  const { evidence, errors } = await executeTaskProbes(context, experiments, {
    stage: "preflight",
    timeoutMs: Math.min(context.options.experimentTimeoutMs, 60000),
    artifactGroup: artifactGroup ?? (afterSetup ? "artifacts/tasks/preflight/checks-after-setup" : "artifacts/tasks/preflight/checks"),
    revisions: Object.fromEntries(discovery.requirements.map(requirement => [`preflight_${requirement.id}`, requirement.revisions])),
  });
  const checks: PreflightResult["checks"] = discovery.requirements.flatMap(requirement => requirement.revisions.map(revision => {
    const record = evidence.find(item => item.hypothesisId === requirement.id && item.revision === revision) ?? null;
    return { requirementId: requirement.id, revision,
      outcome: record?.outcome === "pass" ? "available" : record?.outcome === "violation" ? "missing" : "unknown",
      reason: record?.observation?.details ?? (record ? record.result.timedOut ? "Readiness verification timed out." : `Verification exited with ${record.result.exitCode ?? record.result.signal ?? "no status"} without a valid readiness observation; inspect the captured logs.` : requirement.check ? "Verification could not execute; inspect the preflight errors." : requirement.remediation),
      evidence: record,
    };
  }));
  const required = new Set(discovery.requirements.filter(requirement => requirement.required).map(requirement => requirement.id));
  const readiness = checks.every(check => !required.has(check.requirementId) || check.outcome === "available") ? "ready" : "blocked";
  for (const check of checks.filter(check => required.has(check.requirementId) && check.outcome !== "available")) {
    context.options.onEvent?.({ task: "preflight", stage: "preflight", kind: "progress",
      message: `preflight: warning ${check.requirementId} (${check.revision}, ${check.outcome}): ${check.reason}` });
  }
  return { checks, errors, readiness };
}
