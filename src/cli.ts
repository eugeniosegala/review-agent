#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createConfiguredBridge, resolveConfiguration } from "./config/index.ts";
import { extractReviewSettings } from "./config/schema.ts";
import { RuntimeExecutor } from "./runtime/experiments.ts";
import { runCommand } from "./command.ts";
import { errorMessage } from "./shared/errors.ts";

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const ask = stdin.isTTY && stdout.isTTY ? async (question: string) => {
    const terminal = createInterface({ input: stdin, output: stdout });
    try { return await terminal.question(question, { signal: controller.signal }); }
    finally { terminal.close(); }
  } : undefined;
  try {
    const resolved = await resolveConfiguration(process.argv.slice(2));
    const bridge = await createConfiguredBridge(resolved.config);
    if (!resolved.help) {
      const analyses = [resolved.config.tasks.codeQuality.enabled ? "code-quality" : "", resolved.config.tasks.adversarial.enabled ? "adversarial" : ""].filter(Boolean);
      const supported = new Set(bridge.supportedSettings ?? ["model", "speed", "reasoningEffort", "verbosity"]);
      const settings = [
        supported.has("model") ? `model: ${resolved.config.model ?? "CLI default"}` : "",
        supported.has("speed") ? `speed: ${resolved.config.speed ?? "CLI default"}` : "",
        supported.has("reasoningEffort") ? `reasoning: ${resolved.config.reasoningEffort ?? "CLI default"}` : "",
        supported.has("verbosity") && resolved.config.verbosity ? `verbosity: ${resolved.config.verbosity}` : "",
      ].filter(Boolean);
      console.error(`Agent: ${bridge.name}; ${settings.join("; ")}.`);
      if (bridge.billingRoute) console.error(`Billing: ${bridge.billingRoute}.`);
      console.error(`Review defaults: analyses ${analyses.join(" + ")}; hypotheses ${resolved.config.tasks.adversarial.maxHypotheses}; experiments ${resolved.config.tasks.adversarial.maxExperimentsPerHypothesis}/hypothesis; quality findings ${resolved.config.tasks.codeQuality.maxFindingsPerBatch}/batch; per-task concurrency ${resolved.config.perTaskConcurrency}; agent retries ${resolved.config.agentRetries}; timeouts ${resolved.config.agentTimeoutSeconds}s agent/${resolved.config.tasks.adversarial.probeTimeoutSeconds}s probe.`);
    }
    process.exitCode = await runCommand(resolved.help ? ["--help"] : resolved.args, {
      bridge,
      executor: new RuntimeExecutor(),
      signal: controller.signal,
      write: message => console.log(message),
      onEvent: event => console.error(event.message),
      reviewSettings: extractReviewSettings(resolved.config),
      describe: ask ? () => ask("What would you like reviewed? [Uncommitted changes] ") : undefined,
      clarify: ask ? question => ask(`${question} `) : undefined,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 2;
});
