import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CosineBridge, inspectCosineBilling, verifyCosineBilling } from "../src/bridges/providers/index.ts";
import { createConfiguredBridge } from "../src/config/index.ts";
import { defaultReviewSettings } from "../src/config/schema.ts";
import type { AgentRequest } from "../src/shared/types.ts";

async function fakeCosine(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cosine-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-cos.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const model = value('--model');
const mcpFile = value('--mcp-config');
const responseFormat = value('--response-format');
fs.writeFileSync(path.join(process.cwd(), 'received.json'), JSON.stringify({
  args,
  prompt: value('--prompt'),
  responseFormat: responseFormat ? JSON.parse(responseFormat) : null,
  mcp: JSON.parse(fs.readFileSync(mcpFile, 'utf8')),
  apiKeyPresent: !!process.env.COSINE_API_KEY,
}));
if (model === 'timeout') setInterval(() => {}, 1000);
else if (model === 'failure') process.exit(7);
else if (model === 'malformed') console.log('analysis followed by {"answer":42}');
else if (model === 'repeated') console.log('{"answer":42}{"answer":42}');
else if (model === 'conflicting') console.log('{"answer":42}{"answer":43}');
else if (model === 'invalidshape') console.log('{"answer":"42"}');
else if (model === 'fenced') console.log(' \\u0060\\u0060\\u0060json\\n{"answer":42}\\n\\u0060\\u0060\\u0060 ');
else console.log(JSON.stringify({answer: 42}));
`);
  await chmod(executable, 0o755);
  const request: AgentRequest = {
    task: "code-quality", stage: "code-quality", prompt: "Inspect the frozen source.",
    schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    workspace: root, artifacts: path.join(root, "artifacts"), timeoutMs: 5000,
  };
  return { root, executable, request };
}

test("Cosine bridge translates a task to safe one-shot structured output", async t => {
  const { root, executable, request } = await fakeCosine(t);
  const previous = process.env.COSINE_API_KEY;
  process.env.COSINE_API_KEY = "must-not-be-forwarded";
  t.after(() => previous === undefined ? delete process.env.COSINE_API_KEY : process.env.COSINE_API_KEY = previous);
  const bridge = new CosineBridge({ executable, model: "literal model; $(exit 1)", reasoningEffort: "minimal", speed: "fast", verbosity: "high" });
  assert.deepEqual(await bridge.run(request), { answer: 42 });
  const received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.equal(received.args[0], "start");
  assert.equal(received.args[received.args.indexOf("--model") + 1], "literal model; $(exit 1)");
  assert.equal(received.args[received.args.indexOf("--reasoning") + 1], "low");
  assert.equal(received.args[received.args.indexOf("--workspace") + 1], "os");
  assert.ok(received.args.includes("--enable-agent-commits=false"));
  assert.ok(received.args.includes("--disable-intermediate-updates"));
  assert.ok(received.args.includes("--wsresponses"));
  assert.ok(!received.args.includes("--auto-accept"));
  assert.match(received.prompt, /read-only analysis provider/);
  assert.match(received.prompt, /detailed and evidence-focused/);
  assert.match(received.prompt, /"required":\["answer"\]/);
  assert.match(received.prompt, /Inspect the frozen source/);
  assert.deepEqual(received.mcp, {});
  assert.deepEqual(received.responseFormat, { name: "review_code-quality_code-quality", strict: true, schema: request.schema });
  assert.equal(received.apiKeyPresent, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(request.artifacts, "response.json"), "utf8")), { answer: 42 });
  const invocation = JSON.parse(await readFile(path.join(request.artifacts, "invocation.json"), "utf8"));
  assert.equal(invocation.args[invocation.args.indexOf("--prompt") + 1], "<stored in cosine-prompt.md>");
});

test("Cosine bridge accepts its fenced JSON output and rejects surrounding prose", async t => {
  const { executable, request } = await fakeCosine(t);
  assert.deepEqual(await new CosineBridge({ executable, model: "fenced" }).run(request), { answer: 42 });
  request.artifacts = path.join(request.workspace, "malformed-artifacts");
  await assert.rejects(new CosineBridge({ executable, model: "malformed" }).run(request), /not one JSON value/);
});

test("Cosine bridge accepts only identical repeated structured values", async t => {
  const { executable, request } = await fakeCosine(t);
  assert.deepEqual(await new CosineBridge({ executable, model: "repeated" }).run(request), { answer: 42 });
  request.artifacts = path.join(request.workspace, "conflicting-artifacts");
  await assert.rejects(new CosineBridge({ executable, model: "conflicting" }).run(request), /identical repeated JSON values/);
});

test("Cosine auto mode uses prompt schemas for Lumen models and validates them locally", async t => {
  const { executable, request, root } = await fakeCosine(t);
  await new CosineBridge({ executable, model: "lumen-scout" }).run(request);
  let received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.equal(received.responseFormat, null);
  assert.ok(!received.args.includes("--response-format"));
  assert.match(received.prompt, /Return exactly one JSON value matching this schema/);
  assert.match(received.prompt, /"required":\["answer"\]/);
  assert.deepEqual(JSON.parse(await readFile(path.join(request.artifacts, "cosine-output-mode.json"), "utf8")), {
    mode: "prompt", requested: "auto", model: "lumen-scout",
  });

  request.artifacts = path.join(root, "outpost-artifacts");
  await new CosineBridge({ executable, model: "lumen-outpost" }).run(request);
  received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.equal(received.responseFormat, null);

  request.artifacts = path.join(root, "cli-default-artifacts");
  await new CosineBridge({ executable }).run(request);
  received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.equal(received.responseFormat, null);

  request.artifacts = path.join(root, "forced-native-artifacts");
  await new CosineBridge({ executable, model: "lumen-scout", structuredOutput: "native" }).run(request);
  received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.deepEqual(received.responseFormat.schema, request.schema);
});

test("prompt structured output fails closed when JSON does not satisfy the local schema", async t => {
  const { executable, request } = await fakeCosine(t);
  await assert.rejects(new CosineBridge({ executable, model: "invalidshape", structuredOutput: "prompt" }).run(request), /invalid shape/);
});

test("Cosine process failures and timeouts remain bounded bridge failures", async t => {
  const { executable, request } = await fakeCosine(t);
  await assert.rejects(new CosineBridge({ executable, model: "failure" }).run(request), /exit 7/);
  request.artifacts = path.join(request.workspace, "timeout-artifacts");
  request.timeoutMs = 100;
  await assert.rejects(new CosineBridge({ executable, model: "timeout" }).run(request), /timed out/);
});

test("Cosine is a built-in configured bridge", async () => {
  const bridge = await createConfiguredBridge({
    cli: "cosine", bridgeModules: [], model: "lumen-scout", reasoningEffort: "medium",
    perTaskConcurrency: defaultReviewSettings.perTaskConcurrency, agentTimeoutSeconds: defaultReviewSettings.agentTimeoutSeconds,
    agentRetries: defaultReviewSettings.agentRetries, agentRetryDelaySeconds: defaultReviewSettings.agentRetryDelaySeconds,
    tasks: defaultReviewSettings.tasks,
  });
  assert.equal(bridge.name, "cosine");
  assert.deepEqual(bridge.supportedSettings, ["model", "speed", "reasoningEffort", "verbosity"]);
});

test("Cosine standard speed avoids the WebSocket override and low verbosity stays concise", async t => {
  const { executable, request, root } = await fakeCosine(t);
  await new CosineBridge({ executable, speed: "standard", verbosity: "low" }).run(request);
  const received = JSON.parse(await readFile(path.join(root, "received.json"), "utf8"));
  assert.ok(!received.args.includes("--wsresponses"));
  assert.match(received.prompt, /explanatory string fields concise/);
});

test("Cosine billing inspection distinguishes managed credits from OpenAI OAuth without reading secrets", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cosine-billing-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, ".cosine");
  await mkdir(directory);
  await writeFile(path.join(directory, "config.toml"), `
[auth.openai]
auth_method = ''
[inference]
base_url = 'https://api.cosine.sh'
[config]
logged_in_with_openai = false
`);
  assert.equal((await inspectCosineBilling(home)).provider, "cosine");
  await assert.rejects(verifyCosineBilling("openai", home), /expects openai billing.*Cosine managed inference/);

  await writeFile(path.join(directory, "config.toml"), `
[auth.openai]
auth_method = 'oauth'
[inference]
base_url = 'https://api.cosine.sh'
[config]
logged_in_with_openai = true
`);
  await writeFile(path.join(directory, "auth.openai.json"), "sensitive contents are deliberately not parsed");
  assert.equal((await verifyCosineBilling("openai", home)).provider, "openai");
});
