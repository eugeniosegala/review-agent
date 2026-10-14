import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RuntimeExecutor, writeExperiment } from "../src/runtime/experiments.ts";
import { assertSnapshotUnchanged, exportSnapshot } from "../src/runtime/repository.ts";
import { createFixture, probe } from "./fixtures.ts";
import type { Experiment } from "../src/shared/types.ts";

test("current-runtime probes use distinct snapshots, processes, and scratch directories", async t => {
  const fixture = await createFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-probe-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const experiment: Experiment = { ...probe, files: [{ path: "probe.mjs", content: `import fs from 'node:fs';
const actual = {
  workingDirectory: fs.realpathSync(process.cwd()),
  expectedWorkingDirectory: fs.realpathSync(process.env.REVIEW_REPO),
  scratch: process.env.REVIEW_SCRATCH,
  pid: process.pid,
  noCredential: !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY,
};
fs.writeFileSync(actual.scratch + '/output.txt', 'scratch output');
console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({status:'pass',expected:'separate process and workspace',actual:JSON.stringify(actual),details:'Runtime context check'}));
` }] };
  const payloadDirectory = path.join(root, "payload");
  await writeExperiment(experiment, payloadDirectory);
  const executor = new RuntimeExecutor();
  const observations: { workingDirectory: string; expectedWorkingDirectory: string; scratch: string; pid: number; noCredential: boolean }[] = [];
  for (const [revision, commit] of [["base", fixture.base], ["head", fixture.head]] as const) {
    const snapshot = await exportSnapshot(fixture.repo, commit, path.join(root, revision));
    const record = await executor.execute({ experiment, snapshot, revision, payloadDirectory,
      artifacts: path.join(root, "evidence", revision), timeoutMs: 5000 });
    assert.equal(record.outcome, "pass", record.result.stderr + record.result.stdout);
    observations.push(JSON.parse(record.observation!.actual));
    await assertSnapshotUnchanged(snapshot);
  }
  for (const value of observations) {
    assert.equal(value.workingDirectory, value.expectedWorkingDirectory);
    assert.equal(value.noCredential, true);
  }
  assert.notEqual(observations[0]!.workingDirectory, observations[1]!.workingDirectory);
  assert.notEqual(observations[0]!.scratch, observations[1]!.scratch);
  assert.notEqual(observations[0]!.pid, observations[1]!.pid);
});

test("current-runtime probes reproduce the seeded authorization regression", async t => {
  const fixture = await createFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-regression-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const payloadDirectory = path.join(root, "payload");
  await writeExperiment(probe, payloadDirectory);
  const executor = new RuntimeExecutor();
  for (const [revision, commit, expected] of [["base", fixture.base, "pass"], ["head", fixture.head, "violation"]] as const) {
    const snapshot = await exportSnapshot(fixture.repo, commit, path.join(root, revision));
    const record = await executor.execute({ experiment: probe, snapshot, revision, payloadDirectory,
      artifacts: path.join(root, "evidence", revision), timeoutMs: 5000 });
    assert.equal(record.outcome, expected, record.result.stderr + record.result.stdout);
  }
});
