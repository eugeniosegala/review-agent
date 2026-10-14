import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BridgeRegistry } from "../bridges/bridge.ts";
import { CodexBridge, CosineBridge, inspectCosineBilling, verifyCosineBilling } from "../bridges/providers/index.ts";
import { pathToFileURL } from "node:url";
import { validatePayload } from "../shared/schema.ts";
import { configSchema, defaultReviewSettings } from "./schema.ts";
import type { AgentConfig, AgentConfigInput } from "./schema.ts";

export const bundledConfig = fileURLToPath(new URL("../../review-agent.config.json", import.meta.url));

async function loadConfig(filename: string, optional: boolean): Promise<AgentConfigInput> {
  let raw: string;
  try { raw = await readFile(filename, "utf8"); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Could not read agent config ${filename}: ${(error as Error).message}`); }
  if (Buffer.byteLength(raw) > 65536) throw new Error("Agent config must be smaller than 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`Agent config ${filename} must contain valid JSON.`); }
  const config = validatePayload<AgentConfigInput>(configSchema, value, `Agent config ${filename}`);
  if (config.executable && (config.executable.includes("/") || config.executable.includes("\\"))) config.executable = path.resolve(path.dirname(filename), config.executable);
  if (config.bridgeModules) config.bridgeModules = config.bridgeModules.map(module => path.resolve(path.dirname(filename), module));
  return config;
}

/** Never discover config inside the reviewed repository implicitly. */
export async function resolveConfiguration(args: string[], options: { cwd?: string; defaultPath?: string } = {}): Promise<{ config: AgentConfig; args: string[]; help: boolean }> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    config: { type: "string" }, cli: { type: "string" }, "cli-path": { type: "string" },
    model: { type: "string" }, speed: { type: "string" }, "reasoning-effort": { type: "string" },
    verbosity: { type: "string" }, "billing-provider": { type: "string" }, "structured-output": { type: "string" },
    "bridge-module": { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || !positionals.length) return { config: { cli: "codex", bridgeModules: [], ...defaultReviewSettings }, args: [], help: true };
  const cwd = options.cwd ?? process.cwd();
  const defaults = await loadConfig(options.defaultPath ?? bundledConfig, true);
  const custom = values.config ? await loadConfig(path.resolve(cwd, values.config), false) : {};
  const sharedOverrides: Record<string, unknown> = {};
  for (const [flag, key] of [["cli", "cli"], ["cli-path", "executable"], ["model", "model"], ["speed", "speed"], ["reasoning-effort", "reasoningEffort"], ["verbosity", "verbosity"], ["billing-provider", "billingProvider"], ["structured-output", "structuredOutput"]] as const) {
    if (values[flag] !== undefined) sharedOverrides[key] = values[flag];
  }
  if (values["bridge-module"]) sharedOverrides.bridgeModules = values["bridge-module"].map(module => path.resolve(cwd, module));
  const overrides = sharedOverrides;
  const validated = validatePayload<AgentConfigInput>(configSchema, overrides, "Agent CLI overrides");
  if (validated.executable && (validated.executable.includes("/") || validated.executable.includes("\\"))) validated.executable = path.resolve(cwd, validated.executable);
  const config: AgentConfig = {
    cli: "codex", bridgeModules: [], perTaskConcurrency: defaultReviewSettings.perTaskConcurrency, agentTimeoutSeconds: defaultReviewSettings.agentTimeoutSeconds,
    agentRetries: defaultReviewSettings.agentRetries, agentRetryDelaySeconds: defaultReviewSettings.agentRetryDelaySeconds,
    ...defaults, ...custom, ...validated,
    tasks: {
      preflight: { ...defaultReviewSettings.tasks.preflight, ...defaults.tasks?.preflight, ...custom.tasks?.preflight, ...validated.tasks?.preflight },
      codeQuality: { ...defaultReviewSettings.tasks.codeQuality, ...defaults.tasks?.codeQuality, ...custom.tasks?.codeQuality, ...validated.tasks?.codeQuality },
      adversarial: { ...defaultReviewSettings.tasks.adversarial, ...defaults.tasks?.adversarial, ...custom.tasks?.adversarial, ...validated.tasks?.adversarial },
    },
  };
  if (!config.tasks.codeQuality.enabled && !config.tasks.adversarial.enabled) throw new Error("At least one of tasks.codeQuality or tasks.adversarial must be enabled.");
  return { config, args: positionals, help: false };
}

export async function createConfiguredBridge(config: AgentConfig) {
  const cosineBilling = config.cli === "cosine"
    ? config.billingProvider ? await verifyCosineBilling(config.billingProvider) : await inspectCosineBilling()
    : undefined;
  const registry = new BridgeRegistry()
    .register("codex", options => new CodexBridge(options))
    .register("cosine", options => new CosineBridge(options, cosineBilling));
  for (const modulePath of config.bridgeModules) {
    const module = await import(pathToFileURL(modulePath).href) as { registerBridges?: (registry: BridgeRegistry) => void };
    if (typeof module.registerBridges !== "function") throw new Error("A bridge module must export registerBridges(registry).");
    module.registerBridges(registry);
  }
  return registry.create(config.cli, config);
}
