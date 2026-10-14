import assert from "node:assert/strict";
import test from "node:test";
import { executionOutcome, readObservation, writeExperiment } from "../src/runtime/experiments.ts";
import { minimalEnvironment, runProcess } from "../src/runtime/process.ts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probe } from "./fixtures.ts";

test("timeouts stop a hanging process", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3000);
});

test("cancellation stops an agent process", async () => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).aborted, true);
});

test("bounded output prevents runaway logs", async () => {
  const result = await runProcess(process.execPath, ["-e", "while(true) process.stdout.write('a'.repeat(1000))"], { timeoutMs: 5000, maxOutputBytes: 10000 });
  assert.equal(result.outputLimited, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 10000);
});

test("a failing command without a behavioral observation is not a defect", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.exit(1)"], { timeoutMs: 5000 });
  assert.equal(executionOutcome(result, readObservation(result)), "error");
});

test("multiple observation lines are rejected", async () => {
  const line = 'REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status: "violation", expected: "false", actual: "true", details: "probe" });
  const result = await runProcess(process.execPath, ["-e", `console.log(${JSON.stringify(line)});console.log(${JSON.stringify(line)});process.exit(1)`], { timeoutMs: 5000 });
  assert.equal(readObservation(result), null);
});

test("host credentials and runtime injection flags are not inherited by experiments", () => {
  const env = minimalEnvironment();
  assert.deepEqual(Object.keys(env).sort(), ["LANG", "PATH", "TZ"]);
});

test("probe path traversal cannot escape the payload directory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "probe-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(writeExperiment({ ...probe, files: [{ path: "../escape.mjs", content: "bad" }] }, root), /Unsafe/);
});
