import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { review } from "../src/review.ts";
import { assessmentSchemaFor } from "../src/tasks/adversarial/schemas.ts";
import { validatePayload } from "../src/shared/schema.ts";
import { reportInput } from "../src/tasks/report/input.ts";
import { validateGeneration, validateInvestigation } from "../src/tasks/adversarial/evidence.ts";
import { createFixture, duplicateBoundaryFinding, duplicationFixtureBridge, FixtureBridge, hypothesis, probe } from "./fixtures.ts";
import type { AgentRequest, ReviewOptions } from "../src/shared/types.ts";

async function runFixture(t: test.TestContext, kind: Parameters<typeof createFixture>[0] = "bug", bridge = new FixtureBridge(), overrides: Partial<ReviewOptions> = {}) {
  const fixture = await createFixture(kind);
  const out = await mkdtemp(path.join(os.tmpdir(), "review-results-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));
  const options: ReviewOptions = { ...fixture, out, focus: [], maxHypotheses: 3, agentTimeoutMs: 10000, experimentTimeoutMs: 5000, ...overrides };
  return { ...await review(options, bridge, new RuntimeExecutor()), fixture, bridge };
}

async function assertReportLinks(directory: string, name: string) {
  const file = path.join(directory, name);
  const contents = await readFile(file, "utf8");
  const links = [...contents.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!);
  assert.ok(links.length > 0, `${name} has navigation or evidence links`);
  for (const link of links) await access(path.resolve(path.dirname(file), decodeURI(link)));
  return contents;
}

test("runs the same real probe on both commits and preserves the original checkout", async t => {
  const { report, fixture, bridge, directory } = await runFixture(t);
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]?.status, "reproduced_regression");
  assert.deepEqual(report.adversarial!.evidence.map(e => e.outcome), ["pass", "violation"]);
  assert.equal(report.adversarial!.evidence[0]?.payloadSha256, report.adversarial!.evidence[1]?.payloadSha256);
  assert.equal(bridge.stages.filter(stage => stage === "code-quality").length, 1);
  assert.deepEqual(bridge.stages.filter(stage => ["preflight", "investigate"].includes(stage)).sort(), ["investigate", "preflight"]);
  assert.deepEqual(bridge.stages.filter(stage => !["code-quality", "preflight", "investigate"].includes(stage)), ["generate", "assess", "report"]);
  assert.match(await readFile(path.join(fixture.repo, "access.mjs"), "utf8"), /user.role/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")).head, fixture.head);
  assert.deepEqual((await readdir(directory)).sort(), ["artifacts", "report.json", "report.md", "tasks"]);
  assert.deepEqual((await readdir(path.join(directory, "tasks"))).sort(), ["adversarial.md", "code-quality.md", "preflight.md", "report-generation.md"]);
  await assertReportLinks(directory, "report.md");
  for (const name of ["preflight", "code-quality", "adversarial", "report-generation"]) {
    const taskReport = await assertReportLinks(directory, `tasks/${name}.md`);
    assert.match(taskReport, /Task: \*\*completed\*\*/);
    assert.match(taskReport, /## Evaluated files/);
  }
  assert.match(await readFile(path.join(directory, "tasks", "preflight.md"), "utf8"), /access\.mjs \| examined/);
  assert.match(await readFile(path.join(directory, "tasks", "report-generation.md"), "utf8"), /does not inspect repository source files/);
  assert.deepEqual(report.preflight!.discovery!.examinedFiles, ["access.mjs"]);
  assert.match(await readFile(path.join(directory, "tasks", "adversarial.md"), "utf8"), /reproduced_regression/);
  assert.ok(report.adversarial!.evidence.every(evidence => evidence.stdoutPath.startsWith(path.join(directory, "artifacts", "tasks", "adversarial"))));
});

test("a clean change cannot be promoted by an agent's unsupported defect claim", async t => {
  const { report } = await runFixture(t, "clean");
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]?.status, "not_reproduced");
});

test("a baseline defect is labeled pre-existing", async t => {
  const { report } = await runFixture(t, "preexisting");
  assert.equal(report.adversarial!.findings[0]?.status, "pre_existing");
});

test("an import/setup failure remains inconclusive", async t => {
  const { report } = await runFixture(t, "setup-error");
  assert.equal(report.status, "incomplete");
  assert.equal(report.adversarial!.evidence[1]?.outcome, "error");
  assert.equal(report.adversarial!.findings[0]?.status, "inconclusive");
});

test("unrelated evidence references are rejected and the report is still saved", async t => {
  const bridge = new FixtureBridge();
  bridge.assessment.findings[0]!.evidenceIds = ["invented:head"];
  const { report } = await runFixture(t, "bug", bridge);
  assert.equal(report.status, "incomplete");
  assert.match(report.errors.join(), /nonexistent evidence|assess response has an invalid shape/);
  assert.equal(report.adversarial!.findings[0]?.status, "inconclusive");
});

test("both evidence IDs are required for a reproduced regression", async t => {
  const bridge = new FixtureBridge();
  bridge.assessment.findings[0]!.evidenceIds = ["cross_tenant:head"];
  const { report } = await runFixture(t, "bug", bridge);
  assert.equal(report.adversarial!.findings[0]?.status, "inconclusive");
});

test("a stalled assessment retries once without discarding completed probe evidence", async t => {
  class FlakyAssessmentBridge extends FixtureBridge {
    attempts = 0;
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "assess" && this.attempts++ === 0) throw new Error("simulated stalled assessment");
      return super.run(request);
    }
  }
  const bridge = new FlakyAssessmentBridge();
  const { report, directory } = await runFixture(t, "bug", bridge);
  assert.equal(bridge.attempts, 2);
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]?.status, "reproduced_regression");
  assert.equal(report.adversarial!.errors.length, 0);
  assert.deepEqual(report.timings!.agentCalls.filter(call => call.stage === "assess").map(call => call.artifactId),
    ["tenant_boundary", "tenant_boundary-retry"]);
  const first = JSON.parse(await readFile(path.join(directory, "artifacts", "tasks", "adversarial", "agent", "assess", "tenant_boundary", "attempts.json"), "utf8"));
  const retry = JSON.parse(await readFile(path.join(directory, "artifacts", "tasks", "adversarial", "agent", "assess", "tenant_boundary-retry", "attempts.json"), "utf8"));
  assert.deepEqual(first.attempts.map((attempt: { status: string }) => attempt.status), ["failed"]);
  assert.deepEqual(retry.attempts.map((attempt: { status: string }) => attempt.status), ["completed"]);
});

test("incomplete coverage is disclosed and produces an incomplete workflow", async t => {
  const bridge = new FixtureBridge();
  bridge.investigation = { hypotheses: [], examinedFiles: [], skippedFiles: [], notes: [] };
  const { report } = await runFixture(t, "clean", bridge);
  assert.equal(report.status, "incomplete");
  assert.equal(report.adversarial!.coverage[0]?.status, "unreported");
});

test("source mutations by a bridge invalidate its results", async t => {
  class MutatingBridge extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      await writeFile(path.join(request.workspace, "head", "access.mjs"), "fake source");
      return super.run(request);
    }
  }
  const { report } = await runFixture(t, "bug", new MutatingBridge());
  assert.equal(report.status, "incomplete");
  assert.match(report.errors.join(), /snapshot was modified/);
});

test("generation cannot omit a hypothesis or create duplicate experiments", () => {
  assert.throws(() => validateGeneration({ experiments: [], skipped: [] }, [hypothesis]), /each hypothesis/);
  assert.throws(() => validateGeneration({ experiments: [probe, probe], skipped: [] }, [hypothesis]), /duplicate/);
  const second = { ...structuredClone(probe), id: "cross_tenant_again" };
  assert.doesNotThrow(() => validateGeneration({ experiments: [probe, second], skipped: [] }, [hypothesis], 2));
  assert.throws(() => validateGeneration({ experiments: [probe, second], skipped: [] }, [hypothesis], 1), /experiment budget/);
});

test("a hypothesis can run multiple complementary experiments when configured", async t => {
  const bridge = new FixtureBridge();
  const second = { ...structuredClone(probe), id: "cross_tenant_again", description: "Repeat the boundary check through an independent probe" };
  bridge.generation.experiments.push(second);
  bridge.assessment.findings[0]!.evidenceIds.push("cross_tenant_again:base", "cross_tenant_again:head");
  const { report } = await runFixture(t, "bug", bridge, { maxExperimentsPerHypothesis: 2 });
  assert.equal(report.status, "completed", JSON.stringify(report.errors));
  assert.equal(report.adversarial!.evidence.length, 4);
  assert.equal(report.adversarial!.findings[0]?.status, "reproduced_regression");
});

test("an empty investigation completes without generating speculative probes", async t => {
  const bridge = new FixtureBridge();
  bridge.investigation.hypotheses = [];
  const { report } = await runFixture(t, "clean", bridge);
  assert.equal(report.status, "completed");
  assert.equal(bridge.stages.filter(stage => stage === "code-quality").length, 1);
  assert.deepEqual(bridge.stages.filter(stage => ["preflight", "investigate"].includes(stage)).sort(), ["investigate", "preflight"]);
  assert.equal(bridge.stages.at(-1), "report");
  assert.deepEqual(report.adversarial!.evidence, []);
});

test("coverage uses exact repository-relative changed paths", () => {
  assert.throws(() => validateInvestigation({ hypotheses: [], examinedFiles: ["head/access.mjs"], skippedFiles: [], notes: [] }, ["access.mjs"], 3), /repository-relative/);
});

test("the analysis tasks overlap and reporting joins their separate outputs", async t => {
  const { report, directory } = await runFixture(t);
  assert.deepEqual(report.tasks.map(task => [task.name, task.status]), [["preflight", "completed"], ["code-quality", "completed"], ["adversarial", "completed"], ["report", "completed"]]);
  const [preflight, quality, adversarial, reporting] = report.tasks;
  assert.ok(adversarial!.startedAt! <= preflight!.finishedAt!);
  assert.ok(quality!.startedAt! <= adversarial!.finishedAt!);
  assert.ok(quality!.finishedAt! <= reporting!.startedAt!);
  assert.ok(adversarial!.finishedAt! <= reporting!.startedAt!);
  assert.equal(report.codeQuality!.findings.length, 0);
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.ok(report.reporting!.narrative);
  const saved = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  assert.equal(saved.version, 2);
  assert.ok(saved.codeQuality && saved.adversarial && saved.reporting);
});

test("completed task reports are published while sibling analysis is still running", { timeout: 10000 }, async t => {
  const fixture = await createFixture("bug");
  const out = await mkdtemp(path.join(os.tmpdir(), "review-results-"));
  const runDirectory = path.join(out, "review-live");
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));

  let assessmentStarted!: () => void;
  const assessmentRunning = new Promise<void>(resolve => { assessmentStarted = resolve; });
  let releaseAssessment!: () => void;
  const assessmentRelease = new Promise<void>(resolve => { releaseAssessment = resolve; });
  t.after(() => releaseAssessment());
  class SlowAdversarialBridge extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "assess") {
        assessmentStarted();
        await assessmentRelease;
      }
      return super.run(request);
    }
  }

  let qualityPublished!: () => void;
  const qualityReportReady = new Promise<void>(resolve => { qualityPublished = resolve; });
  const events: string[] = [];
  const options: ReviewOptions = { ...fixture, out, runDirectory, focus: [], maxHypotheses: 3,
    agentTimeoutMs: 10000, experimentTimeoutMs: 5000,
    onEvent: event => {
      events.push(event.message);
      if (event.task === "code-quality" && event.kind === "completed") qualityPublished();
    } };
  const pending = review(options, new SlowAdversarialBridge(), new RuntimeExecutor());
  await Promise.all([assessmentRunning, qualityReportReady]);

  const quality = await readFile(path.join(runDirectory, "tasks", "code-quality.md"), "utf8");
  assert.match(quality, /Task: \*\*completed\*\*\. Review: \*\*running\*\*/);
  const adversarial = await readFile(path.join(runDirectory, "tasks", "adversarial.md"), "utf8");
  assert.match(adversarial, /Task: \*\*running\*\*/);
  const live = JSON.parse(await readFile(path.join(runDirectory, "report.json"), "utf8"));
  assert.equal(live.status, "running");
  assert.equal(live.tasks.find((task: { name: string }) => task.name === "code-quality").status, "completed");
  assert.equal(live.tasks.find((task: { name: string }) => task.name === "adversarial").status, "running");
  assert.ok(live.codeQuality);
  assert.equal(live.adversarial, null);
  assert.ok(events.some(message => message.startsWith(`Live report: ${path.join(runDirectory, "report.md")}`)));
  assert.ok(events.some(message => message.includes(path.join(runDirectory, "tasks", "code-quality.md"))));

  releaseAssessment();
  const { report } = await pending;
  assert.equal(report.status, "completed");
});

test("quality recommendations remain advisory without becoming behavioral defects", async t => {
  const { report, directory } = await runFixture(t, "duplication", duplicationFixtureBridge());
  assert.equal(report.status, "completed");
  assert.equal(report.codeQuality!.findings[0]!.category, "duplication");
  assert.equal(report.adversarial!.findings.length, 0);
  assert.equal(report.adversarial!.evidence.length, 0);
  assert.deepEqual(report.reporting!.narrative!.priorities.map(p => p.source), ["code-quality"]);
  const qualityReport = await assertReportLinks(directory, "tasks/code-quality.md");
  assert.match(qualityReport, /Recommendation:/);
  assert.match(qualityReport, /\[source\]\(\.\.\/artifacts\/context\/head\//);
});

test("invalid quality source evidence is rejected while adversarial testing still completes", async t => {
  const bridge = new FixtureBridge();
  const finding = structuredClone(duplicateBoundaryFinding);
  finding.locations[0]!.snippet = "fabricated source line";
  bridge.qualityReview.findings = [finding];
  const { report } = await runFixture(t, "bug", bridge);
  assert.equal(report.codeQuality!.status, "incomplete");
  assert.equal(report.codeQuality!.findings.length, 0);
  assert.match(report.codeQuality!.errors.join(), /invalid source line/);
  assert.equal(report.adversarial!.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.equal(report.reporting!.status, "completed");
});

test("a duplication recommendation needs two distinct source locations", async t => {
  const bridge = duplicationFixtureBridge();
  bridge.qualityReview.findings[0]!.locations.pop();
  const { report } = await runFixture(t, "duplication", bridge);
  assert.match(report.codeQuality!.errors.join(), /two distinct/);
  assert.equal(report.codeQuality!.findings.length, 0);
});

test("the report cannot invent finding references or erase verified evidence", async t => {
  const bridge = new FixtureBridge();
  bridge.narrative.priorities = [{ source: "adversarial", findingId: "invented", reason: "Unsupported invented finding" }];
  const { report, directory } = await runFixture(t, "bug", bridge);
  assert.equal(report.reporting!.status, "incomplete");
  assert.equal(report.reporting!.narrative, null);
  assert.match(report.errors.join(), /nonexistent adversarial finding/);
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.match(await readFile(path.join(directory, "tasks", "adversarial.md"), "utf8"), /reproduced_regression/);
});

test("a failed reporting agent still leaves the quality and adversarial outputs inspectable", async t => {
  class FailedReporter extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.task === "report") throw new Error("Reporting CLI unavailable");
      return super.run(request);
    }
  }
  const { report, directory } = await runFixture(t, "bug", new FailedReporter());
  assert.equal(report.status, "incomplete");
  assert.equal(report.codeQuality!.status, "completed");
  assert.equal(report.adversarial!.status, "completed");
  assert.equal(report.reporting!.status, "incomplete");
  assert.match(await readFile(path.join(directory, "report.md"), "utf8"), /Reporting CLI unavailable/);
  assert.match(await assertReportLinks(directory, "tasks/report-generation.md"), /Task: \*\*incomplete\*\*/);
  assert.match(await assertReportLinks(directory, "tasks/adversarial.md"), /reproduced_regression/);
});

test("the same line on baseline and head is not evidence of duplicated code", async t => {
  const bridge = duplicationFixtureBridge();
  bridge.qualityReview.findings[0]!.locations = [
    { ...duplicateBoundaryFinding.locations[0]!, revision: "base" },
    { ...duplicateBoundaryFinding.locations[0]!, revision: "head" },
  ];
  const { report } = await runFixture(t, "duplication", bridge);
  assert.match(report.codeQuality!.errors.join(), /within one revision/);
  assert.equal(report.codeQuality!.findings.length, 0);
});


test("investigation overlaps setup, but generation receives final preflight diagnostics", { timeout: 10000 }, async t => {
  let investigated!: () => void;
  const investigationDone = new Promise<void>(resolve => { investigated = resolve; });
  let setupFinished = false;
  class OverlapBridge extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "preflight") {
        await investigationDone;
        const value = await super.run(request);
        setupFinished = true;
        return value;
      }
      if (request.stage === "generate") {
        assert.ok(setupFinished);
        const diagnostics = JSON.parse(await readFile(path.join(request.workspace, "preflight-context.json"), "utf8"));
        assert.equal(diagnostics.readiness, "ready");
        assert.ok(diagnostics.checks.length > 0);
      }
      const value = await super.run(request);
      if (request.stage === "investigate") {
        assert.equal(setupFinished, false);
        investigated();
      }
      return value;
    }
  }
  const { report } = await runFixture(t, "bug", new OverlapBridge());
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.ok(report.timings!.preparationMs > 0);
  assert.ok(report.timings!.totalMs >= report.timings!.preparationMs);
  assert.equal(report.timings!.agentCalls.length, 6);
  assert.ok(report.tasks.every(task => task.durationMs !== undefined && task.durationMs >= 0));
});

test("reporting input keeps validated outcomes without duplicating raw payloads and logs", async t => {
  const { report } = await runFixture(t);
  const evidence = report.adversarial!.evidence[0]!;
  evidence.result.stdout += "x".repeat(100000);
  const before = structuredClone(report);
  const input = reportInput(report);
  assert.deepEqual(input.adversarial!.findings, report.adversarial!.findings);
  assert.deepEqual(input.adversarial!.coverage, report.adversarial!.coverage);
  assert.deepEqual(input.adversarial!.evidence[0]!.observation, evidence.observation);
  assert.equal(input.adversarial!.evidence[0]!.stdoutPath, evidence.stdoutPath);
  assert.ok(!("stdout" in input.adversarial!.evidence[0]!.result!));
  assert.ok(!("files" in input.adversarial!.generation!.experiments[0]!));
  assert.ok(JSON.stringify(input).length < JSON.stringify(report).length / 2);
  assert.deepEqual(report, before);
});


test("assessment schema requires both real execution IDs even for identical commits", async t => {
  const { report } = await runFixture(t, "preexisting");
  const hypotheses = report.adversarial!.investigation!.hypotheses;
  const evidence = report.adversarial!.evidence;
  const schema = assessmentSchemaFor(hypotheses, evidence);
  const finding = { hypothesisId: hypotheses[0]!.id, verdict: "defect", confidence: "high", explanation: "Observed on both executions.",
    expectationJustification: "The contract is supported by source.", evidenceIds: evidence.map(item => item.id) };
  assert.doesNotThrow(() => validatePayload(schema, { findings: [finding] }, "assessment"));
  assert.throws(() => validatePayload(schema, { findings: [{ ...finding, evidenceIds: [evidence[1]!.id] }] }, "assessment"), /invalid shape/);
  assert.throws(() => validatePayload(schema, { findings: [{ ...finding, evidenceIds: [evidence[0]!.id, "invented:head"] }] }, "assessment"), /invalid shape/);
});
