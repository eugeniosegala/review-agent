import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../src/bridges/providers/index.ts";
import { BridgeRegistry } from "../src/bridges/bridge.ts";
import type { AgentRequest } from "../src/shared/types.ts";
import { FixtureBridge } from "./fixtures.ts";

async function fakeCli(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const schemaFile = args[args.indexOf('--output-schema') + 1];
const prompt = fs.readFileSync(0, 'utf8');
const model = args[args.indexOf('--model') + 1];
if (model === 'timeout') { setInterval(() => {}, 1000); }
else {
  fs.writeFileSync(path.join(path.dirname(output), 'received.json'), JSON.stringify({args,prompt,cwd:process.cwd(),schema:JSON.parse(fs.readFileSync(schemaFile,'utf8')),apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  if (model !== 'missing') fs.writeFileSync(output, model === 'malformed' ? 'invalid JSON' : JSON.stringify({answer:42}));
  if (model === 'recovered') console.log(JSON.stringify({type:'error',message:'Reconnecting after a transient transport error'}));
  console.log(JSON.stringify(model === 'failure' ? {type:'turn.failed'} : {type:'turn.completed'}));
}
`);
  await chmod(executable, 0o755);
  const request: AgentRequest = { task: "adversarial", stage: "investigate", prompt: "Read this literal prompt: $(touch /tmp/nope)",
    schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    workspace: root, artifacts: path.join(root, "artifacts"), timeoutMs: 5000 };
  return { root, executable, request };
}

test("Codex bridge delivers stdin, schema, model, and normalized JSON through a real subprocess", async t => {
  const { executable, request } = await fakeCli(t);
  const bridge = new CodexBridge({ executable, model: "literal model; $(exit 1)" });
  assert.deepEqual(await bridge.run(request), { answer: 42 });
  const received = JSON.parse(await readFile(path.join(request.artifacts, "received.json"), "utf8"));
  assert.equal(received.prompt, request.prompt);
  assert.equal(received.cwd, await realpath(request.workspace));
  assert.deepEqual(received.schema, request.schema);
  assert.ok(received.args.includes("literal model; $(exit 1)"));
  assert.equal(received.args[received.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(received.apiKeyPresent, false);
});

test("Codex error events override an otherwise valid response", async t => {
  const { executable, request } = await fakeCli(t);
  await assert.rejects(new CodexBridge({ executable, model: "failure" }).run(request), /terminal failure/);
});

test("a stale response cannot be reused when the CLI produces no new response", async t => {
  const { executable, request } = await fakeCli(t);
  await new CodexBridge({ executable }).run(request);
  await assert.rejects(new CodexBridge({ executable, model: "missing" }).run(request), /no valid JSON/);
});

test("malformed CLI responses fail closed", async t => {
  const { executable, request } = await fakeCli(t);
  await assert.rejects(new CodexBridge({ executable, model: "malformed" }).run(request), /no valid JSON/);
});

test("a hanging CLI leaves bounded diagnostics and terminates", async t => {
  const { executable, request } = await fakeCli(t);
  request.timeoutMs = 100;
  await assert.rejects(new CodexBridge({ executable, model: "timeout" }).run(request), /timed out/);
  assert.equal(JSON.parse(await readFile(path.join(request.artifacts, "process.json"), "utf8")).timedOut, true);
});

test("a registry can add other bridges without changing the review pipeline", () => {
  const registry = new BridgeRegistry().register("other-cli", () => new FixtureBridge());
  assert.equal(registry.create("other-cli").name, "fixture");
  assert.throws(() => registry.create("cosine"), /Unknown bridge/);
  assert.throws(() => registry.register("other-cli", () => new FixtureBridge()), /duplicate/);
});

test("a recovered transport error does not override a completed Codex turn", async t => {
  const { executable, request } = await fakeCli(t);
  assert.deepEqual(await new CodexBridge({ executable, model: "recovered" }).run(request), { answer: 42 });
});

test("Codex bridge forwards reasoning, speed, and verbosity as explicit config arguments", async t => {
  const { executable, request } = await fakeCli(t);
  await new CodexBridge({ executable, model: "chosen-model", reasoningEffort: "xhigh", speed: "fast", verbosity: "low" }).run(request);
  let received = JSON.parse(await readFile(path.join(request.artifacts, "received.json"), "utf8"));
  const values = (args: string[]) => args.flatMap((arg, index) => arg === "-c" ? [args[index + 1]!] : []);
  assert.deepEqual(values(received.args), ['approval_policy="never"', 'model_reasoning_effort="xhigh"', 'service_tier="fast"', 'features.fast_mode=true', 'model_verbosity="low"']);
  assert.equal(received.args[received.args.indexOf("--model") + 1], "chosen-model");
  await new CodexBridge({ executable, speed: "standard" }).run(request);
  received = JSON.parse(await readFile(path.join(request.artifacts, "received.json"), "utf8"));
  assert.ok(values(received.args).includes('service_tier="default"'));
  assert.ok(values(received.args).includes('features.fast_mode=false'));
  assert.ok(!values(received.args).some((value: string) => value.startsWith("model_reasoning_effort=")));
});
