import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgentWithRetries } from "../src/runtime/agent-retry.ts";
import type { AgentBridge, AgentEvent, AgentRequest } from "../src/shared/types.ts";

const answerSchema = {
  type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false,
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: AgentEvent[] = [];
  const request: AgentRequest = { task: "request", stage: "plan", prompt: "Return an answer", schema: answerSchema,
    workspace: root, artifacts: path.join(root, "artifacts"), timeoutMs: 1000, onEvent: event => events.push(event) };
  return { root, events, request };
}

test("agent retries recover from an invalid response and preserve every attempt", async t => {
  const { request, events } = await fixture(t);
  const artifacts: string[] = [];
  let calls = 0;
  const bridge: AgentBridge = { name: "flaky", async run(current) {
    artifacts.push(current.artifacts);
    return calls++ ? { answer: 42 } : { answer: "wrong type" };
  } };
  assert.deepEqual(await runAgentWithRetries(bridge, request, { retries: 1, delayMs: 0, label: "answer" }), { answer: 42 });
  assert.deepEqual(artifacts, [request.artifacts, path.join(request.artifacts, "retries", "attempt-2")]);
  assert.match(events[0]!.message, /retrying plan \(attempt 2\/2\)/);
  const audit = JSON.parse(await readFile(path.join(request.artifacts, "attempts.json"), "utf8"));
  assert.deepEqual(audit.attempts.map((attempt: { status: string }) => attempt.status), ["failed", "completed"]);
  assert.match(audit.attempts[0].error, /invalid shape/);
});

test("agent retries stay bounded and retain the original terminal failure", async t => {
  const { request } = await fixture(t);
  let calls = 0;
  const bridge: AgentBridge = { name: "down", async run() { calls++; throw new Error("provider unavailable"); } };
  await assert.rejects(runAgentWithRetries(bridge, request, { retries: 1, delayMs: 0, label: "answer" }), /provider unavailable/);
  assert.equal(calls, 2);
  const audit = JSON.parse(await readFile(path.join(request.artifacts, "attempts.json"), "utf8"));
  assert.deepEqual(audit.attempts.map((attempt: { status: string }) => attempt.status), ["failed", "failed"]);
});

test("an integrity failure after an attempt is never retried", async t => {
  const { request } = await fixture(t);
  let calls = 0;
  let verifications = 0;
  const bridge: AgentBridge = { name: "mutating", async run() { calls++; return { answer: 42 }; } };
  await assert.rejects(runAgentWithRetries(bridge, request, { retries: 3, delayMs: 0, label: "answer",
    verifyAttempt: async () => { if (++verifications === 2) throw new Error("frozen source changed"); },
  }), /frozen source changed/);
  assert.equal(calls, 1);
  const audit = JSON.parse(await readFile(path.join(request.artifacts, "attempts.json"), "utf8"));
  assert.deepEqual(audit.attempts.map((attempt: { status: string }) => attempt.status), ["failed"]);
});
