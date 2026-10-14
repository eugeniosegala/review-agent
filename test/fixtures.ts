import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentBridge, AgentRequest, Assessment, CodeQualityFinding, CodeQualityReview, Experiment, Generation, Hypothesis, Investigation, PreflightDiscovery, ReportNarrative } from "../src/shared/types.ts";

export const fixturePreflight: PreflightDiscovery = {
  approach: "Exercise the exported access module directly; no server or external service is required.",
  requirements: [{ id: "node_runtime", category: "runtime", description: "Compatible Node runtime", required: true,
    revisions: ["base", "head"], sources: [{ revision: "head", path: "access.mjs" }], remediation: "Supply Node.js 18 or newer in the test environment.",
    check: { parallelSafe: true, argv: ["node", "{{experiments}}/check.mjs"], files: [{ path: "check.mjs", content:
      `const available = Number(process.versions.node.split('.')[0]) >= 18;\nconsole.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({status:available?'pass':'violation',expected:'Node >=18',actual:process.version,details:available?'Runtime is compatible':'Runtime is incompatible'}));\nprocess.exitCode = available ? 0 : 1;\n` }] } }],
  examinedFiles: ["access.mjs"], skippedFiles: [], notes: [],
};

export const hypothesis: Hypothesis = {
  id: "tenant_boundary", title: "Editor role bypasses the organization boundary", severity: "high",
  claim: "An editor can read another organization's document.", invariant: "Document reads require matching organization IDs.",
  expectationSource: "SPEC.md: roles do not bypass organization isolation.", changedFiles: ["access.mjs"],
  testIdea: "Ask whether an editor from organization A can read a document owned by organization B.",
};

export const probe: Experiment = {
  id: "cross_tenant", hypothesisId: hypothesis.id, description: "Exercise cross-organization reads by an editor",
  parallelSafe: true,
  argv: ["node", "{{experiments}}/probe.mjs"],
  files: [{ path: "probe.mjs", content: `import path from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  const { canRead } = await import(pathToFileURL(path.join(process.env.REVIEW_REPO, 'access.mjs')).href);
  const actual = canRead({ organizationId: 'A', role: 'editor' }, { organizationId: 'B' });
  const status = actual === false ? 'pass' : 'violation';
  console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status, expected: 'false', actual: String(actual), details: 'Editor A reading document B' }));
  process.exitCode = status === 'pass' ? 0 : 1;
} catch (error) {
  console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status: 'error', expected: 'load canRead', actual: String(error), details: 'Probe setup failed' }));
  process.exitCode = 2;
}
` }],
};

export const duplicateBoundaryFinding: CodeQualityFinding = {
  id: "shared_boundary", title: "Read and edit duplicate the organization ownership rule",
  category: "duplication", origin: "introduced", severity: "medium", changedFiles: ["access.mjs"],
  explanation: "Both access operations now implement the same organization ownership comparison, which must evolve consistently.",
  recommendation: "Extract the common organization ownership rule and reuse it from both operations.",
  locations: [
    { revision: "head", path: "access.mjs", line: 1, snippet: "export function canRead(user, document) { return user.organizationId === document.organizationId; }" },
    { revision: "head", path: "access.mjs", line: 2, snippet: "export function canEdit(user, document) { return user.organizationId === document.organizationId; }" },
  ],
};

export class FixtureBridge implements AgentBridge {
  readonly name = "fixture";
  readonly stages: string[] = [];
  preflight: PreflightDiscovery = structuredClone(fixturePreflight);
  qualityReview: CodeQualityReview = { findings: [], examinedFiles: ["access.mjs"], skippedFiles: [], reviewedChunks: [], moreFindings: false, notes: [] };
  narrative: ReportNarrative = { summary: "Review results are bounded by the examined changes and executed probes.", priorities: [], notes: [] };
  investigation: Investigation = { hypotheses: [hypothesis], examinedFiles: ["access.mjs"], skippedFiles: [], notes: [] };
  generation: Generation = { experiments: [probe], skipped: [] };
  assessment: Assessment = { findings: [{ hypothesisId: hypothesis.id, verdict: "defect", confidence: "high",
    explanation: "The editor role bypasses the organization check.", expectationJustification: "SPEC.md explicitly requires organization isolation regardless of role.",
    evidenceIds: ["cross_tenant:base", "cross_tenant:head"] }] };
  async run(request: AgentRequest): Promise<unknown> {
    this.stages.push(request.stage);
    switch (request.stage) {
      case "preflight": return structuredClone(this.preflight);
      case "code-quality": {
        const response = structuredClone(this.qualityReview);
        const properties = request.schema.properties as Record<string, { items: { enum: string[] } }>;
        response.reviewedChunks = properties.reviewedChunks!.items.enum;
        return response;
      }
      case "investigate": return structuredClone(this.investigation);
      case "generate": return structuredClone(this.generation);
      case "assess": {
        const response = structuredClone(this.assessment);
        const properties = request.schema.properties as { findings: { items: { anyOf: { properties: { hypothesisId: { enum: string[] } } }[] } } };
        const hypothesisIds = new Set(properties.findings.items.anyOf.flatMap(item => item.properties.hypothesisId.enum));
        response.findings = response.findings.filter(item => hypothesisIds.has(item.hypothesisId));
        return response;
      }
      case "report": return structuredClone(this.narrative);
      default: throw new Error(`Unexpected fixture stage: ${request.stage}`);
    }
  }
}

export function duplicationFixtureBridge(): FixtureBridge {
  const bridge = new FixtureBridge();
  bridge.qualityReview.findings = [structuredClone(duplicateBoundaryFinding)];
  bridge.investigation.hypotheses = [];
  bridge.narrative.priorities = [{ source: "code-quality", findingId: duplicateBoundaryFinding.id, reason: "Keep the shared organization rule consistent across access operations." }];
  return bridge;
}

export async function createFixture(kind: "bug" | "clean" | "preexisting" | "setup-error" | "duplication" = "bug"): Promise<{ repo: string; base: string; head: string }> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "review-fixture-"));
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Review fixture"]);
  const good = "export function canRead(user, document) { return user.organizationId === document.organizationId; }\n";
  const bad = "export function canRead(user, document) { return user.organizationId === document.organizationId || user.role === 'editor'; }\n";
  await writeFile(path.join(repo, "SPEC.md"), "Document reads require matching organization IDs. Roles do not bypass organization isolation.\n" + (kind === "duplication" ? "Reading and editing must use the same organization ownership rule.\n" : ""));
  await writeFile(path.join(repo, "access.mjs"), kind === "preexisting" ? bad : good);
  git(["add", "."]); git(["commit", "-qm", "Baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "access.mjs"), kind === "clean" ? good + "// Clarify access policy.\n" : kind === "duplication" ? good + "export function canEdit(user, document) { return user.organizationId === document.organizationId; }\n" : kind === "setup-error" ? "throw new Error('unavailable dependency');\n" : bad + (kind === "preexisting" ? "// Existing behavior.\n" : ""));
  git(["add", "."]); git(["commit", "-qm", "Change"]);
  return { repo, base, head: git(["rev-parse", "HEAD"]) };
}
