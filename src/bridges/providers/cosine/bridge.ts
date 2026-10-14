import path from "node:path";
import type { AgentRequest } from "../../../shared/types.ts";
import type { BridgeOptions } from "../../bridge.ts";
import { CliBridge } from "../../cli.ts";
import type { CliInvocation } from "../../cli.ts";
import type { CosineBillingRoute } from "./billing.ts";
import { cosineReasoning, cosineStructuredOutputMode, normalizeCosineModelOutput } from "./models/compatibility.ts";

const readOnlyInstructions = `You are running as a read-only analysis provider inside a deterministic review pipeline.
Read files needed for the requested analysis. Do not modify files, run shell commands, initialize the project, create commits, use external services, or broaden the requested scope.
Return only the JSON value required by the supplied schema.`;

function responseName(request: AgentRequest): string {
  return `review_${request.task}_${request.stage}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function verbosityInstruction(verbosity: BridgeOptions["verbosity"]): string {
  if (verbosity === "low") return "Keep explanatory string fields concise while preserving required evidence.";
  if (verbosity === "high") return "Make explanatory string fields detailed and evidence-focused without adding unsupported claims.";
  return "Use balanced detail in explanatory string fields and preserve required evidence.";
}

/** Translate the stable agent contract to Cosine's one-shot structured-output protocol. */
export class CosineBridge extends CliBridge {
  readonly name = "cosine";
  readonly supportedSettings = ["model", "speed", "reasoningEffort", "verbosity"] as const;
  readonly billingRoute?: string;
  private options: BridgeOptions;

  constructor(options: BridgeOptions = {}, billingRoute?: CosineBillingRoute) {
    super();
    this.options = options;
    this.billingRoute = billingRoute?.description;
  }

  protected translate(request: AgentRequest, schemaFile: string, _resultFile: string, _promptFile: string): CliInvocation {
    const artifacts = path.dirname(schemaFile);
    const effectivePrompt = path.join(artifacts, "cosine-prompt.md");
    const mcpConfig = path.join(artifacts, "cosine-mcp.json");
    const reasoning = cosineReasoning(this.options.reasoningEffort);
    const outputMode = cosineStructuredOutputMode(this.options.model, this.options.structuredOutput);
    const outputInstruction = outputMode === "prompt"
      ? "Return exactly one JSON value matching this schema. Do not add Markdown fences, prose, or tool-call text."
      : "The top-level response must conform exactly to this JSON Schema.";
    const prompt = `${readOnlyInstructions}\n${verbosityInstruction(this.options.verbosity)}\n${outputInstruction}\n${JSON.stringify(request.schema)}\n\n${request.prompt}\n`;
    const args = [
      "start",
      // Cosine 2.0.30 supports one-shot --prompt; newer releases also document --prompt-file.
      "--prompt", prompt,
      ...(outputMode === "native" ? ["--response-format", JSON.stringify({ name: responseName(request), strict: true, schema: request.schema })] : []),
      "--workspace", "os",
      "--mode", "normal",
      "--enable-agent-commits=false",
      "--enable-api-sessions=false",
      "--enable-project-setup=false",
      "--disable-intermediate-updates",
      "--parallel-tool-calls=true",
      ...(this.options.speed === "fast" ? ["--wsresponses"] : []),
      "--mcp-config", mcpConfig,
      "--tool-call-limit", "terminal=0,edit=0,web_search=0,web_fetch=0,browser=0,computer=0",
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(reasoning ? ["--reasoning", reasoning] : []),
    ];
    const auditArgs = [...args];
    auditArgs[auditArgs.indexOf("--prompt") + 1] = `<stored in ${path.basename(effectivePrompt)}>`;
    return {
      executable: this.options.executable ?? "cos",
      args,
      auditArgs,
      files: [
        { path: effectivePrompt, content: prompt },
        { path: mcpConfig, content: "{}\n" },
        { path: path.join(artifacts, "cosine-output-mode.json"), content: `${JSON.stringify({ mode: outputMode, requested: this.options.structuredOutput ?? "auto", model: this.options.model ?? null }, null, 2)}\n` },
      ],
      // Reuse the installed CLI's login while excluding API keys and unrelated host state.
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8", TZ: "UTC",
      },
    };
  }

  protected normalizeOutput(output: string): unknown {
    return normalizeCosineModelOutput(output);
  }
}
