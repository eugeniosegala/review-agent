import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createConfiguredBridge, resolveConfiguration } from "../src/config/index.ts";
import { defaultReviewSettings } from "../src/config/schema.ts";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const defaultPath = path.join(directory, "default.json");
  await writeFile(defaultPath, JSON.stringify({
    cli: "codex", model: "bundled-model", speed: "fast", reasoningEffort: "high", perTaskConcurrency: 2,
    tasks: { adversarial: { maxHypotheses: 4 } },
  }));
  return { directory, defaultPath };
}

test("bundled config, explicit config, and CLI overrides have deterministic precedence", async t => {
  const { directory, defaultPath } = await fixture(t);
  await writeFile(path.join(directory, "custom.json"), JSON.stringify({ model: "custom-model", reasoningEffort: "medium", structuredOutput: "native", tasks: { adversarial: { maxHypotheses: 8 } } }));
  const { config, args } = await resolveConfiguration(["--config", "custom.json", "../app", "Focus on authorization", "--model", "cli-model", "--speed=standard", "--structured-output=prompt"], { cwd: directory, defaultPath });
  assert.deepEqual(config, {
    cli: "codex", model: "cli-model", speed: "standard", reasoningEffort: "medium", structuredOutput: "prompt", bridgeModules: [],
    perTaskConcurrency: 2, agentTimeoutSeconds: defaultReviewSettings.agentTimeoutSeconds,
    agentRetries: defaultReviewSettings.agentRetries, agentRetryDelaySeconds: defaultReviewSettings.agentRetryDelaySeconds,
    tasks: {
      preflight: defaultReviewSettings.tasks.preflight,
      codeQuality: defaultReviewSettings.tasks.codeQuality,
      adversarial: { ...defaultReviewSettings.tasks.adversarial, maxHypotheses: 8 },
    },
  });
  assert.deepEqual(args, ["../app", "Focus on authorization"]);
});

test("a config inside the reviewed project is not implicitly trusted", async t => {
  const { directory, defaultPath } = await fixture(t);
  const reviewed = path.join(directory, "app");
  await mkdir(reviewed);
  await writeFile(path.join(reviewed, "review-agent.config.json"), JSON.stringify({ cli: "untrusted", model: "unexpected" }));
  const { config } = await resolveConfiguration(["."], { cwd: reviewed, defaultPath });
  assert.equal(config.cli, "codex");
  assert.equal(config.model, "bundled-model");
});

test("relative executables and bridge modules resolve against their config, CLI paths against cwd", async t => {
  const { directory, defaultPath } = await fixture(t);
  const nested = path.join(directory, "config");
  await mkdir(nested);
  await writeFile(path.join(nested, "custom.json"), JSON.stringify({ executable: "./bin/codex", bridgeModules: ["./other.ts"] }));
  const loaded = await resolveConfiguration(["app", "--config", "config/custom.json"], { cwd: directory, defaultPath });
  assert.equal(loaded.config.executable, path.join(nested, "bin", "codex"));
  assert.deepEqual(loaded.config.bridgeModules, [path.join(nested, "other.ts")]);
  const overridden = await resolveConfiguration(["app", "--config", "config/custom.json", "--cli-path", "./tools/codex", "--bridge-module", "./bridge.ts"], { cwd: directory, defaultPath });
  assert.equal(overridden.config.executable, path.join(directory, "tools", "codex"));
  assert.deepEqual(overridden.config.bridgeModules, [path.join(directory, "bridge.ts")]);
});

test("typos, invalid settings, and missing explicit configs fail before invoking any agent", async t => {
  const { directory, defaultPath } = await fixture(t);
  for (const value of [{ speed: "instant" }, { reasoningEffort: "extreme" }, { structuredOutput: "sometimes" }, { modle: "typo" },
    { model: 1 }, { executable: "a\nb" }, { tasks: { adversarial: { maxHypotheses: 21 } } },
    { perTaskConcurrency: 0 }, { concurrency: 3 }, { tasks: { codeQuality: { unknown: true } } }, { global: {} }, null]) {
    await writeFile(path.join(directory, "invalid.json"), JSON.stringify(value));
    await assert.rejects(resolveConfiguration(["app", "--config", "invalid.json"], { cwd: directory, defaultPath }), /invalid shape/);
  }
  await assert.rejects(resolveConfiguration(["app", "--speed", "instant"], { cwd: directory, defaultPath }), /invalid shape/);
  await writeFile(path.join(directory, "disabled.json"), JSON.stringify({ tasks: { codeQuality: { enabled: false }, adversarial: { enabled: false } } }));
  await assert.rejects(resolveConfiguration(["app", "--config", "disabled.json"], { cwd: directory, defaultPath }), /At least one/);
  await assert.rejects(resolveConfiguration(["app", "--config", "missing.json"], { cwd: directory, defaultPath }), /Could not read/);
});

test("help does not require a working config and -- preserves prose that resembles flags", async t => {
  const { directory, defaultPath } = await fixture(t);
  await writeFile(defaultPath, "broken JSON");
  assert.equal((await resolveConfiguration(["--help"], { defaultPath })).help, true);
  await writeFile(defaultPath, "{}");
  const result = await resolveConfiguration(["app", "--", "--model is mentioned in this source change"], { cwd: directory, defaultPath });
  assert.deepEqual(result.args, ["app", "--model is mentioned in this source change"]);
});

test("configured bridge registration preserves settings for other CLI implementations", async t => {
  const { directory, defaultPath } = await fixture(t);
  const module = path.join(directory, "bridge.mjs");
  await writeFile(module, `export function registerBridges(registry) {
  registry.register('other', options => ({name:'other',run:async request=>({model:options.model,speed:options.speed,reasoning:options.reasoningEffort,prompt:request.prompt})}));
}`);
  const { config } = await resolveConfiguration(["app", "--cli", "other", "--bridge-module", module], { defaultPath });
  const bridge = await createConfiguredBridge(config);
  const result = await bridge.run({ task: "request", stage: "plan", prompt: "Literal request", schema: {}, workspace: directory, artifacts: directory, timeoutMs: 1000 });
  assert.deepEqual(result, { model: "bundled-model", speed: "fast", reasoning: "high", prompt: "Literal request" });
  await assert.rejects(createConfiguredBridge({ ...config, cli: "missing" }), /Unknown bridge/);
});
