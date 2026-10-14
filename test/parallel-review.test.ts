import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { review } from "../src/review.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { createFixture, FixtureBridge, hypothesis, probe } from "./fixtures.ts";
import type { AgentRequest, ExecutionEvidence, ExperimentExecutor, ExperimentRequest, ReviewOptions } from "../src/shared/types.ts";

async function run(t: test.TestContext, bridge: FixtureBridge, executor: ExperimentExecutor = new RuntimeExecutor(), perTaskConcurrency = 2,
  overrides: Partial<ReviewOptions> = {}) {
  const fixture = await createFixture();
  const out = await mkdtemp(path.join(os.tmpdir(), "parallel-review-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(out, { recursive: true, force: true })]));
  return review({ ...fixture, out, focus: [], maxHypotheses: 3, agentTimeoutMs: 5000,
    experimentTimeoutMs: 5000, perTaskConcurrency, signal: t.signal, ...overrides }, bridge, executor);
}

test("analysis tasks can wait for each other to start; report waits for both to finish", { timeout: 10000 }, async t => {
  class BarrierBridge extends FixtureBridge {
    private qualityStarted = Promise.withResolvers<void>();
    private investigationStarted = Promise.withResolvers<void>();
    private assessed = Promise.withResolvers<void>();
    private qualityFinished = false;
    readonly workspaces = new Map<string, string>();
    override async run(request: AgentRequest): Promise<unknown> {
      this.workspaces.set(request.task, request.workspace);
      if (request.stage === "code-quality") {
        this.qualityStarted.resolve();
        await this.investigationStarted.promise;
        await this.assessed.promise;
        this.qualityFinished = true;
      } else if (request.stage === "investigate") {
        this.investigationStarted.resolve();
        await this.qualityStarted.promise;
      } else if (request.stage === "assess") this.assessed.resolve();
      else if (request.stage === "report") assert.equal(this.qualityFinished, true);
      return super.run(request);
    }
  }
  const bridge = new BarrierBridge();
  const { report } = await run(t, bridge);
  assert.equal(report.status, "completed");
  assert.equal(bridge.workspaces.size, 4);
  assert.equal(new Set(bridge.workspaces.values()).size, 4);
});

class TrackingExecutor implements ExperimentExecutor {
  readonly name = "tracking-runtime";
  private runtime = new RuntimeExecutor();
  private active = new Set<string>();
  maximum = 0;
  readonly requests: ExperimentRequest[] = [];
  async execute(request: ExperimentRequest): Promise<ExecutionEvidence> {
    const key = `${request.experiment.id}:${request.revision}`;
    assert.ok(![...this.active].some(item => item.startsWith("serial:")), "a shared-resource probe overlapped other work");
    if (!request.experiment.parallelSafe) assert.equal(this.active.size, 0);
    this.active.add(key);
    this.requests.push(request);
    this.maximum = Math.max(this.maximum, this.active.size);
    try { return await this.runtime.execute(request); }
    finally { this.active.delete(key); }
  }
}

test("parallel-safe base/head jobs overlap using distinct source, probe, and scratch paths", async t => {
  const executor = new TrackingExecutor();
  const { report } = await run(t, new FixtureBridge(), executor);
  assert.equal(report.status, "completed");
  assert.equal(executor.maximum, 2);
  const probes = executor.requests.filter(r => !r.experiment.id.startsWith("preflight_"));
  assert.equal(new Set(probes.map(r => r.snapshot.directory)).size, 2);
  assert.equal(new Set(probes.map(r => r.payloadDirectory)).size, 2);
  assert.equal(new Set(probes.map(r => r.artifacts)).size, 2);
  assert.deepEqual(report.adversarial!.evidence.map(e => e.revision), ["base", "head"]);
  assert.equal(report.adversarial!.evidence[0]!.payloadSha256, report.adversarial!.evidence[1]!.payloadSha256);
});

test("shared-resource probes run serially after parallel work drains", async t => {
  const bridge = new FixtureBridge();
  bridge.investigation.hypotheses.push({ ...hypothesis, id: "serial_hypothesis" });
  bridge.generation.experiments.push({ ...probe, id: "serial", hypothesisId: "serial_hypothesis", parallelSafe: false });
  bridge.assessment.findings.push({ ...bridge.assessment.findings[0]!, hypothesisId: "serial_hypothesis", evidenceIds: ["serial:base", "serial:head"] });
  const executor = new TrackingExecutor();
  const { report } = await run(t, bridge, executor);
  assert.equal(report.status, "completed");
  assert.equal(executor.maximum, 2);
  assert.deepEqual(executor.requests.filter(r => !r.experiment.id.startsWith("preflight_")).map(r => r.experiment.id), ["cross_tenant", "cross_tenant", "serial", "serial"]);
});

test("one exhausted assessment preserves findings from the other hypotheses", async t => {
  class PartiallyStalledBridge extends FixtureBridge {
    failedAttempts = 0;
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "assess" && request.artifacts.includes(`${path.sep}serial_hypothesis`)) {
        this.failedAttempts++;
        throw new Error("simulated repeated assessment timeout");
      }
      return super.run(request);
    }
  }
  const bridge = new PartiallyStalledBridge();
  bridge.investigation.hypotheses.push({ ...hypothesis, id: "serial_hypothesis" });
  bridge.generation.experiments.push({ ...probe, id: "serial", hypothesisId: "serial_hypothesis", parallelSafe: false });
  bridge.assessment.findings.push({ ...bridge.assessment.findings[0]!, hypothesisId: "serial_hypothesis", evidenceIds: ["serial:base", "serial:head"] });
  const { report } = await run(t, bridge);
  assert.equal(bridge.failedAttempts, 2);
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.adversarial!.findings.map(finding => finding.status), ["reproduced_regression", "inconclusive"]);
  assert.match(report.adversarial!.errors.join("\n"), /serial_hypothesis: assessment failed after one retry/);
});

test("per-task concurrency one serializes otherwise parallel-safe probes", async t => {
  const executor = new TrackingExecutor();
  const { report } = await run(t, new FixtureBridge(), executor, 1);
  assert.equal(report.status, "completed");
  assert.equal(executor.maximum, 1);
  assert.equal(report.storage!.executionCopiesCreated, 2);
});

test("a failed probe does not abandon its active sibling or start assessment early", { timeout: 10000 }, async t => {
  const siblingStarted = Promise.withResolvers<void>();
  let siblingFinished = false;
  class OneFailedExecutor extends TrackingExecutor {
    override async execute(request: ExperimentRequest): Promise<ExecutionEvidence> {
      if (request.experiment.id.startsWith("preflight_")) return super.execute(request);
      if (request.revision === "base") {
        await siblingStarted.promise;
        throw new Error("baseline executor failed");
      }
      siblingStarted.resolve();
      const result = await super.execute(request);
      siblingFinished = true;
      return result;
    }
  }
  class CheckingBridge extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "assess") {
        assert.equal(siblingFinished, true, "assessment started before the active sibling finished");
        this.assessment.findings[0]!.verdict = "inconclusive";
        this.assessment.findings[0]!.evidenceIds = ["cross_tenant:head"];
      }
      return super.run(request);
    }
  }
  const { report } = await run(t, new CheckingBridge(), new OneFailedExecutor());
  assert.equal(report.status, "incomplete");
  assert.equal(report.adversarial!.evidence.length, 1);
  assert.equal(report.adversarial!.findings[0]!.status, "inconclusive");
  assert.equal(report.reporting!.status, "completed");
  assert.match(report.errors.join(), /baseline executor failed/);
});

test("setup-only probe evidence triggers one bounded regeneration and re-execution", async t => {
  class FirstProbeIsBroken implements ExperimentExecutor {
    readonly name = "first-probe-broken";
    private runtime = new RuntimeExecutor();
    private remainingFailures = 2;
    async execute(request: ExperimentRequest): Promise<ExecutionEvidence> {
      const record = await this.runtime.execute(request);
      if (!request.experiment.id.startsWith("preflight_") && this.remainingFailures-- > 0) {
        record.outcome = "error";
        record.observation = { status: "error", expected: "Runnable probe", actual: "Invalid fixture shape", details: "The generated setup was invalid." };
        record.result.exitCode = 2;
      }
      return record;
    }
  }
  const bridge = new FixtureBridge();
  const { report } = await run(t, bridge, new FirstProbeIsBroken(), 2, { probeRepairAttempts: 1 });
  assert.equal(bridge.stages.filter(stage => stage === "generate").length, 2);
  assert.equal(report.adversarial!.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.match(report.adversarial!.investigation!.notes.join("\n"), /Regenerated probes/);
});
