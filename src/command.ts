import path from "node:path";
import { performance } from "node:perf_hooks";
import { ClarificationRequired, planReview, prepareRequest } from "./request/index.ts";
import { review } from "./review.ts";
import { resolveTargetArguments } from "./request/target.ts";
import type { AgentBridge, ExperimentExecutor, ReviewOptions } from "./shared/types.ts";
import type { ReviewSettings } from "./config/schema.ts";

export const help = `Usage: review-agent PATH ["describe what you want reviewed"] [options]

Examples:
  review-agent ../my-app
  review-agent ../my-app "Review my uncommitted edits, focusing on authorization"
  review-agent ../my-app "Only run adversarial testing and run tests one at a time"

With just a path, describe the review when prompted. Press Enter to review all uncommitted changes.
Defaults to staged, unstaged, and non-ignored untracked contents against HEAD.
Describe a file, full repository, commit, or branch review in your prompt.
Reports are saved in the target project's reports directory.

Agent settings come from the bundled config. An explicit config overlays it; CLI flags win.
Review defaults in configuration control analyses, dependency setup, hypothesis/finding budgets,
per-task concurrency, and timeouts. Natural-language instructions can override them for one run.
  --config PATH                Load an additional JSON config
  --cli NAME                   Agent CLI bridge: codex or cosine
  --cli-path PATH              Override its executable
  --model NAME                 Override the model
  --speed standard|fast        Override processing speed
  --reasoning-effort LEVEL     none, minimal, low, medium, high, xhigh, max, ultra
  --verbosity low|medium|high  Override model response verbosity
  --billing-provider NAME      Expected billing account: cosine or openai
  --structured-output MODE     Schema transport: auto, native, or prompt
  --bridge-module PATH         Register a trusted local bridge; repeatable
  --help                       Show help

Exit codes: 0 = completed without reproduced regressions; 1 = reproduced regression;
            2 = incomplete review or execution error.
`;

export interface CommandDependencies {
  bridge: AgentBridge;
  executor: ExperimentExecutor;
  write(message: string): void;
  describe?: () => Promise<string>;
  clarify?: (question: string) => Promise<string>;
  signal?: AbortSignal;
  onEvent?: ReviewOptions["onEvent"];
  reviewSettings?: ReviewSettings;
}

/** The user supplies a path and prose; infrastructure choices remain outside the prompt. */
export async function runCommand(args: string[], dependencies: CommandDependencies): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { dependencies.write(help); return 0; }
  if (args[0]!.startsWith("--")) throw new Error('Use review-agent PATH "describe what you want reviewed".');
  const [target, ...description] = await resolveTargetArguments(args);
  let instructions = description.join(" ").trim() || (await dependencies.describe?.())?.trim() || "Review my uncommitted changes for behavioral regressions and opportunities to reuse code.";
  let interpreted: Awaited<ReturnType<typeof planReview>>;
  const started = performance.now();
  const prepared = await prepareRequest(target!, dependencies.signal);
  for (let attempt = 0; ; attempt++) {
    try {
      interpreted = await planReview(target!, instructions, dependencies.bridge, {
        signal: dependencies.signal, onEvent: dependencies.onEvent, prepared, reviewSettings: dependencies.reviewSettings,
      });
      break;
    } catch (error) {
      if (!(error instanceof ClarificationRequired) || !dependencies.clarify || attempt >= 2) throw error;
      const answer = (await dependencies.clarify(error.message)).trim();
      if (!answer) throw error;
      instructions += `\nClarification question: ${error.message}\nUser answer: ${answer}`;
    }
  }
  const requestMs = performance.now() - started;
  dependencies.write(interpreted.plan.summary);
  const head = interpreted.options.workingTree ? "frozen working tree" : interpreted.options.head.slice(0, 12);
  dependencies.write(`Comparison: ${interpreted.options.base.slice(0, 12)} → ${head}; scope: ${interpreted.options.reviewScope} under ${interpreted.options.focus.join(", ") || "repository"}; analyses: ${interpreted.options.analyses!.join(", ")}.`);
  dependencies.write(`Review settings: hypotheses ${interpreted.plan.maxHypotheses}; experiments ${interpreted.plan.maxExperimentsPerHypothesis}/hypothesis; quality findings ${interpreted.plan.maxQualityFindings}/batch; per-task concurrency ${interpreted.plan.perTaskConcurrency}; dependencies ${interpreted.plan.installDependencies ? "install if needed" : "reuse only"}; timeouts ${interpreted.plan.agentTimeoutSeconds}s agent/${interpreted.plan.testTimeoutSeconds}s probe.`);
  const { report, directory } = await review(interpreted.options, dependencies.bridge, dependencies.executor);
  dependencies.write(`Review ${report.status}: ${report.codeQuality?.findings.length ?? 0} quality recommendation(s), ${report.adversarial?.findings.filter(f => f.status === "reproduced_regression").length ?? 0} reproduced regression(s), ${report.adversarial?.findings.filter(f => f.status === "pre_existing").length ?? 0} existing behavioral issue(s), ${report.adversarial?.findings.filter(f => f.status === "inconclusive").length ?? 0} inconclusive probe(s).`);
  dependencies.write(`Elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s; request preparation/planning: ${(requestMs / 1000).toFixed(1)}s; review: ${((report.timings?.totalMs ?? 0) / 1000).toFixed(1)}s.`);
  dependencies.write(`Report: ${path.join(directory, "report.md")}`);
  for (const error of report.errors) dependencies.write(error);
  return report.status === "incomplete" ? 2 : report.adversarial?.findings.some(f => f.status === "reproduced_regression") ? 1 : 0;
}
