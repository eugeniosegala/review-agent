import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { review } from "../src/review.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import type { AgentRequest, CodeQualityFinding, CodeQualityReview } from "../src/shared/types.ts";
import type { SourceChunk } from "../src/tasks/source-inventory.ts";
import { consolidateQualityFindings } from "../src/tasks/code-quality/consolidate.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";

class InspectingBridge extends FixtureBridge {
  readonly requests: AgentRequest[] = [];
  readonly chunks: SourceChunk[] = [];
  respond?: (response: CodeQualityReview, request: AgentRequest) => CodeQualityReview;
  override async run(request: AgentRequest): Promise<unknown> {
    if (request.task !== "code-quality") return super.run(request);
    this.requests.push(request);
    const chunks = JSON.parse(request.prompt.match(/^Source chunks \(JSON\): (.+)$/m)![1]!) as SourceChunk[];
    this.chunks.push(...chunks);
    const response: CodeQualityReview = { findings: [], examinedFiles: [...new Set(chunks.map(chunk => chunk.path))],
      skippedFiles: [], reviewedChunks: chunks.map(chunk => chunk.id), moreFindings: false, notes: [] };
    return this.respond?.(response, request) ?? response;
  }
}

async function run(t: test.TestContext, files: Record<string, string | Buffer>, bridge = new InspectingBridge(), focus: string[] = []) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(fixture.repo, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", fixture.repo, ...args], { encoding: "utf8" }).trim();
  git(["add", "."]); git(["commit", "-qm", "Selected source"]);
  const head = git(["rev-parse", "HEAD"]);
  return { ...await review({ repo: fixture.repo, base: head, head, out: path.join(fixture.repo, "reports"), focus,
    reviewScope: "all", comparison: "branch", analyses: ["code-quality"], maxHypotheses: 3,
    agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, bridge, new RuntimeExecutor()), bridge };
}

test("whole-source quality review examines unchanged files even with an empty diff", async t => {
  const source = "export const retryLimit = 7;\nexport const eventName = 'payment.settled';\n";
  const { report, bridge } = await run(t, { "billing.mjs": source });
  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedFiles, []);
  assert.ok(report.reviewFiles.includes("billing.mjs"));
  assert.ok(bridge.chunks.some(chunk => chunk.path === "billing.mjs" && chunk.content.includes(source)));
  assert.equal(report.codeQuality!.coverage.find(entry => entry.path === "billing.mjs")!.status, "examined");
});

test("literal hints include matching strings in unchanged modules outside the selected path", async t => {
  const { report, bridge, directory } = await run(t, {
    "sender.mjs": "export const event = 'payment.settled';\n",
    "receiver.mjs": "export const acceptedEvent = 'payment.settled';\n",
  }, new InspectingBridge(), ["sender.mjs"]);
  assert.deepEqual(report.reviewFiles, ["sender.mjs"]);
  const hints = JSON.parse(bridge.requests[0]!.prompt.match(/^Literal hints \(JSON\): (.+)$/m)![1]!);
  const event = hints.find((item: { value: string }) => item.value === "payment.settled");
  assert.ok(event.locations.some((location: { path: string }) => location.path === "receiver.mjs"));
  assert.equal(event.occurrenceCount, 2);
  assert.ok(event.locations.every((location: { snippet?: string }) => location.snippet === undefined));
  assert.deepEqual(report.codeQuality!.findings, []); // A lexical match is not automatically a recommendation.
  const inventory = JSON.parse(await readFile(path.join(directory, "artifacts", "tasks", "code-quality", "context", "review-inventory.json"), "utf8"));
  assert.ok(inventory.repeatedStrings.length > 0);
});

test("large files are supplied in full through separate bounded batches", async t => {
  const source = Array.from({ length: 4000 }, (_, index) => `export const value_${index} = 'domain_event_${index}';`).join("\n");
  const { report, bridge } = await run(t, { "large.mjs": source }, new InspectingBridge(), ["large.mjs"]);
  assert.equal(report.status, "completed");
  assert.ok(bridge.requests.length > 1);
  assert.equal(new Set(bridge.requests.map(request => request.artifacts)).size, bridge.requests.length);
  const supplied = bridge.chunks.filter(chunk => chunk.revision === "head").sort((a, b) => a.startLine - b.startLine);
  assert.equal(supplied.map(chunk => chunk.content).join(""), source + "\n");
  assert.ok(report.codeQuality!.batches.every(batch => batch.suppliedChunks.length === batch.reviewedChunks.length));
});

test("batch packing keeps a complete source domain out of an unrelated partial batch", async t => {
  const text = (label: string, characters: number) => Array.from({ length: Math.ceil(characters / (label.length + 4)) }, () => `// ${label}`).join("\n");
  const { report } = await run(t, {
    "src/config/config.mjs": text("config", 20_000),
    "src/pipeline/pipeline.mjs": text("pipeline", 20_000),
    "src/providers/redbox/provider.mjs": text("provider", 42_000),
    "src/storage/azure.mjs": text("azure", 10_000),
    "src/storage/local.mjs": text("local", 10_000),
    "src/utils/helper.mjs": text("utility", 10_000),
  }, new InspectingBridge(), ["src"]);
  const providerBatch = report.codeQuality!.batches.find(batch => batch.domains.includes("src/providers"))!;
  const storageBatch = report.codeQuality!.batches.find(batch => batch.domains.includes("src/storage"))!;
  assert.notEqual(providerBatch.id, storageBatch.id);
  assert.deepEqual(storageBatch.files.filter(file => file.startsWith("src/storage/")), ["src/storage/azure.mjs", "src/storage/local.mjs"]);
});

test("parallel batch findings sharing validated structural evidence are consolidated", () => {
  const first: CodeQualityFinding = {
    id: "batch_1_policy", title: "Policy is duplicated", category: "reuse", origin: "pre_existing", severity: "low",
    explanation: "Two adapters own the same policy.", recommendation: "Move the policy to a shared owner.", changedFiles: ["src/azure.mjs"],
    locations: [
      { revision: "head", path: "src/azure.mjs", line: 20, snippet: "return windowsOverlap(left, right);" },
      { revision: "head", path: "src/local.mjs", line: 20, snippet: "return windowsOverlap(left, right);" },
    ],
  };
  const second: CodeQualityFinding = {
    ...structuredClone(first), id: "batch_2_policy", title: "Window overlap has two owners", category: "duplication",
    changedFiles: ["src/local.mjs"], locations: [
      { revision: "head", path: "src/local.mjs", line: 20, snippet: "return windowsOverlap(left, right);" },
      { revision: "head", path: "src/policy.mjs", line: 8, snippet: "return windowsOverlap(left, right);" },
    ],
  };
  const separate: CodeQualityFinding = { ...structuredClone(first), id: "mixed_responsibilities", category: "responsibility" };
  const result = consolidateQualityFindings([first, second, separate]);
  assert.deepEqual(result.findings.map(finding => finding.id), ["batch_1_policy", "mixed_responsibilities"]);
  assert.deepEqual(result.findings[0]!.changedFiles, ["src/azure.mjs", "src/local.mjs"]);
  assert.equal(result.findings[0]!.locations.length, 3);
  assert.match(result.notes.join("\n"), /batch_2_policy.*batch_1_policy/);
});

test("one shared line does not merge findings about unrelated concepts", () => {
  const source = { revision: "head" as const, path: "src/config.mjs", line: 1, snippet: "configure('billing', 'production');" };
  const billing: CodeQualityFinding = { id: "billing", title: "Billing event has no owner", category: "duplicate-string", origin: "pre_existing", severity: "low",
    explanation: "The billing event is repeated in consumers.", recommendation: "Centralize the billing event.", changedFiles: [source.path], locations: [source] };
  const environment: CodeQualityFinding = { id: "environment", title: "Environment name has no owner", category: "duplicate-string", origin: "pre_existing", severity: "low",
    explanation: "The deployment environment name is repeated.", recommendation: "Centralize the environment name.", changedFiles: [source.path], locations: [source] };
  assert.deepEqual(consolidateQualityFindings([billing, environment]).findings.map(finding => finding.id), ["billing", "environment"]);
});

test("claiming file examination without reviewing all its source chunks remains incomplete", async t => {
  const bridge = new InspectingBridge();
  bridge.respond = response => ({ ...response, reviewedChunks: response.reviewedChunks.slice(1) });
  const { report } = await run(t, { "values.mjs": "export const limit = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.codeQuality!.coverage[0]!.status, "unreported");
  assert.match(report.codeQuality!.errors.join(), /chunks were not examined/);
});

const constantFinding: CodeQualityFinding = {
  id: "retry_constant", title: "Retry count should have an owner", category: "hardcoded-constant", origin: "pre_existing", severity: "low",
  explanation: "The policy embeds a retry count without a named domain constant.", recommendation: "Give the retry policy a named constant.",
  changedFiles: ["values.mjs"], locations: [{ revision: "head", path: "values.mjs", line: 1, snippet: "export const retries = 7;" }],
};

test("a capped batch preserves source-backed findings and reports its incomplete result", async t => {
  const bridge = new InspectingBridge();
  bridge.respond = response => ({ ...response, findings: [structuredClone(constantFinding)], moreFindings: true });
  const { report, directory } = await run(t, { "values.mjs": "export const retries = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.status, "incomplete");
  assert.equal(report.codeQuality!.findings[0]!.category, "hardcoded-constant");
  assert.equal(report.codeQuality!.coverage[0]!.status, "examined");
  assert.match(await readFile(path.join(directory, "tasks", "code-quality.md"), "utf8"), /exceed this batch/);
});

test("duplicate-string recommendations require two real locations in the same revision", async t => {
  const bridge = new InspectingBridge();
  bridge.respond = response => ({ ...response, findings: [{ ...structuredClone(constantFinding), category: "duplicate-string" }] });
  const { report } = await run(t, { "values.mjs": "export const retries = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.codeQuality!.findings, []);
  assert.match(report.codeQuality!.errors.join(), /two distinct code locations/);
});

test("filesystem metadata is visibly skipped without pretending an agent reviewed it", async t => {
  const { report, bridge, directory } = await run(t, { ".DS_Store": Buffer.from([0, 0, 1, 255]) }, new InspectingBridge(), [".DS_Store"]);
  assert.equal(report.codeQuality!.status, "completed");
  assert.equal(bridge.requests.length, 0);
  assert.equal(report.codeQuality!.coverage[0]!.status, "skipped");
  assert.match(await readFile(path.join(directory, "tasks", "code-quality.md"), "utf8"), /filesystem metadata/);
});


test("byte-identical baseline/head source is supplied once with both revisions represented", async t => {
  const source = "export const retries = 7;\nexport const status = 'payment.settled';\n";
  const { report, bridge } = await run(t, { "values.mjs": source }, new InspectingBridge(), ["values.mjs"]);
  assert.equal(report.status, "completed");
  assert.equal(bridge.chunks.length, 1);
  assert.equal(bridge.chunks[0]!.revision, "head");
  assert.equal(bridge.chunks[0]!.equivalentRevision, "base");
  assert.equal(bridge.chunks[0]!.content, source + "\n");
  assert.match(bridge.requests[0]!.prompt, /same code across revisions/);
});

test("changed source retains the complete text of both revisions", async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  const bridge = new InspectingBridge();
  const { report } = await review({ ...fixture, out: path.join(fixture.repo, "reports"), focus: [],
    analyses: ["code-quality"], maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed");
  assert.deepEqual(bridge.chunks.map(chunk => chunk.revision), ["base", "head"]);
  assert.ok(bridge.chunks.every(chunk => chunk.equivalentRevision === undefined));
  assert.notEqual(bridge.chunks[0]!.content, bridge.chunks[1]!.content);
});


test("an exact unique source quote corrects a wrong line number without changing raw agent output", async t => {
  const bridge = new InspectingBridge();
  const supplied = structuredClone(constantFinding);
  supplied.locations[0]!.line = 20;
  bridge.respond = response => ({ ...response, findings: [supplied] });
  const { report } = await run(t, { "values.mjs": "export const retries = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.status, "completed");
  assert.equal(report.codeQuality!.findings[0]!.locations[0]!.line, 1);
  assert.equal(supplied.locations[0]!.line, 20);
  assert.match(report.codeQuality!.notes.join(), /unique exact quote/);
});

test("invalid candidates preserve valid findings and full source examination receipts", async t => {
  const bridge = new InspectingBridge();
  bridge.respond = response => ({ ...response, findings: [structuredClone(constantFinding),
    { ...structuredClone(constantFinding), id: "fabricated", locations: [{ revision: "head", path: "values.mjs", line: 1, snippet: "fabricated line" }] }] });
  const { report } = await run(t, { "values.mjs": "export const retries = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.codeQuality!.findings.map(item => item.id), ["retry_constant"]);
  assert.equal(report.codeQuality!.coverage[0]!.status, "examined");
  assert.equal(report.codeQuality!.batches[0]!.reviewedChunks.length, report.codeQuality!.batches[0]!.suppliedChunks.length);
  assert.match(report.codeQuality!.errors.join(), /fabricated/);
});

test("citation recovery accepts verified source and explicitly rejects unsupported candidates", async t => {
  class RepairingBridge extends InspectingBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.artifacts.endsWith("-citation-repair")) return { repairs: [
        { findingId: "retry_constant", locations: [{ revision: "head", path: "values.mjs", line: 2, snippet: "export const retries = 7;" }], reason: "The declaration is the second matching line, as established by its surrounding function." },
      ], rejected: [{ findingId: "fabricated", reason: "The alleged source does not exist." }] };
      return super.run(request);
    }
  }
  const bridge = new RepairingBridge();
  bridge.respond = response => ({ ...response, findings: [
    { ...structuredClone(constantFinding), locations: [{ revision: "head", path: "values.mjs", line: 20, snippet: "export const retries = 7;" }] },
    { ...structuredClone(constantFinding), id: "fabricated", locations: [{ revision: "head", path: "values.mjs", line: 1, snippet: "fabricated line" }] },
  ] });
  const { report } = await run(t, { "values.mjs": "export const retries = 7;\nexport const retries = 7;\n" }, bridge, ["values.mjs"]);
  assert.equal(report.codeQuality!.status, "completed");
  assert.deepEqual(report.codeQuality!.findings.map(item => item.id), ["retry_constant"]);
  assert.equal(report.codeQuality!.findings[0]!.locations[0]!.line, 2);
  assert.match(report.codeQuality!.notes.join(), /unsupported candidate rejected/);
});
