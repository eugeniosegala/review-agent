import type { AgentRequest, ProcessResult } from "../../shared/types.ts";
import type { BridgeOptions } from "../bridge.ts";
import { CliBridge } from "../cli.ts";
import type { CliInvocation } from "../cli.ts";

export class CodexBridge extends CliBridge {
  readonly name = "codex";
  readonly supportedSettings = ["model", "speed", "reasoningEffort", "verbosity"] as const;
  private options: BridgeOptions;

  constructor(options: BridgeOptions = {}) { super(); this.options = options; }

  protected translate(request: AgentRequest, schemaFile: string, resultFile: string, _promptFile: string): CliInvocation {
    return {
      executable: this.options.executable ?? "codex",
      args: [
        "exec", "--json", "--ephemeral", "--skip-git-repo-check",
        "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules",
        "-c", "approval_policy=\"never\"",
        "--output-schema", schemaFile, "--output-last-message", resultFile,
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(this.options.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(this.options.reasoningEffort)}`] : []),
        ...(this.options.speed ? ["-c", `service_tier=${JSON.stringify(this.options.speed === "fast" ? "fast" : "default")}`,
          "-c", `features.fast_mode=${this.options.speed === "fast"}`] : []),
        ...(this.options.verbosity ? ["-c", `model_verbosity=${JSON.stringify(this.options.verbosity)}`] : []),
        "-",
      ],
      stdin: request.prompt,
      resultFile,
      // Preserve the installed CLI's existing login, without forwarding API-key env vars.
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
        TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8", TZ: "UTC",
      },
    };
  }

  protected validateEvents(result: ProcessResult): void {
    let terminal: string | undefined;
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: { type?: string };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "turn.failed" || event.type === "turn.completed") terminal = event.type;
    }
    // Codex emits error events during recoverable reconnects. The terminal turn
    // outcome, not an intermediate transport error, determines task success.
    if (terminal !== "turn.completed") throw new Error("Codex emitted a terminal failure or no completed turn; inspect the recorded events.log");
  }
}
