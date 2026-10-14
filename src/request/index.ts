import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { readGit, resolveCommit, safeRelativePath } from "../runtime/repository.ts";
import { captureWorkingTree } from "../runtime/working-tree.ts";
import { runAgentWithRetries } from "../runtime/agent-retry.ts";
import type { AgentBridge, ReviewOptions, WorkingTreeCapture } from "../shared/types.ts";
import { requestPrompt } from "./prompt.ts";
import { planSchema } from "./schema.ts";
import type { ReviewPlan } from "./schema.ts";
import { locateTarget } from "./target.ts";
import { defaultReviewSettings } from "../config/schema.ts";
import type { ReviewSettings } from "../config/schema.ts";

export class ClarificationRequired extends Error {}

export interface RequestOptions {
  signal?: AbortSignal;
  onEvent?: ReviewOptions["onEvent"];
  prepared?: PreparedRequest;
  reviewSettings?: ReviewSettings;
}

export interface PreparedRequest {
  repo: string;
  pathFocus: string[];
  directory: string;
  captured: WorkingTreeCapture;
  branch: string | null;
}

/** Allocate one run and freeze its source before any planning or clarification. */
export async function prepareRequest(target: string, signal?: AbortSignal): Promise<PreparedRequest> {
  signal?.throwIfAborted();
  const { repo, scope: pathFocus } = await locateTarget(target);
  const output = path.join(repo, "reports");
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, "review-"));
  const captured = await captureWorkingTree(repo, path.join(directory, "artifacts", "snapshots"));
  const branch = await readGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(value => value.toString("utf8").trim()).catch(() => null);
  return { repo, pathFocus, directory, captured, branch };
}

/** Interpret prose, then pin the requested comparison without changing the checkout. */
export async function planReview(target: string, instructions: string, bridge: AgentBridge, options: RequestOptions = {}): Promise<{ options: ReviewOptions; plan: ReviewPlan; directory: string }> {
  if (!instructions.trim() || instructions.length > 12000) throw new Error("Describe the review in 1–12000 characters.");
  options.signal?.throwIfAborted();
  const { repo, pathFocus, directory, captured, branch } = options.prepared ?? await prepareRequest(target, options.signal);
  const output = path.join(repo, "reports");
  const requestDirectory = path.join(directory, "artifacts", "request");
  let sourcePaths = [...new Set([...captured.base.files, ...captured.head.files, ...captured.changedFiles])];
  const details = { baseline: captured.base.commit, branch, changedFiles: captured.changedFiles, paths: sourcePaths };
  const workspace = path.join(requestDirectory, "context");
  await mkdir(workspace, { recursive: true });
  options.signal?.throwIfAborted();
  const schema = planSchema();
  const reviewSettings = options.reviewSettings ?? defaultReviewSettings;
  const plan = await runAgentWithRetries<ReviewPlan>(bridge, {
    task: "request", stage: "plan", prompt: requestPrompt(instructions, details, pathFocus, reviewSettings), schema,
    workspace, artifacts: path.join(requestDirectory, "agent"), timeoutMs: reviewSettings.agentTimeoutSeconds * 1000,
    signal: options.signal, onEvent: options.onEvent,
  }, { retries: reviewSettings.agentRetries, delayMs: reviewSettings.agentRetryDelaySeconds * 1000, label: "Review plan" });
  if (new Set(plan.analyses).size !== plan.analyses.length) throw new Error("Review plan contains duplicate analyses.");
  await writeFile(path.join(requestDirectory, "plan.json"), JSON.stringify({ instructions, reviewDefaults: reviewSettings, plan,
    baseline: captured.base.commit, workingTree: captured.head.commit }, null, 2));
  if (plan.clarification) throw new ClarificationRequired(plan.clarification);
  const { kind, ref, baseRef } = plan.comparison;
  if (kind === "repository" && plan.reviewScope !== "all" || kind === "branch" && !baseRef && plan.reviewScope !== "all") {
    throw new Error("Repository reviews and branches without a comparison baseline must review all selected source.");
  }
  let base = captured.base.commit;
  let head = captured.head.commit;
  let workingTree: WorkingTreeCapture | undefined = captured;
  if (kind === "commit" || kind === "branch") {
    if (!ref) throw new ClarificationRequired("Which commit or branch should I review?");
    head = await resolveCommit(repo, ref);
    try { base = await resolveCommit(repo, baseRef ?? (kind === "commit" ? `${head}^` : head)); }
    catch { throw new ClarificationRequired("This comparison has no resolvable baseline. Specify the base commit or branch to compare against."); }
    workingTree = undefined;
    const paths = await Promise.all([base, head].map(commit => readGit(repo, ["ls-tree", "-r", "--name-only", "-z", commit])));
    sourcePaths = [...new Set(paths.flatMap(value => value.toString("utf8").split("\0").filter(Boolean)))];
  } else if (ref || baseRef) throw new ClarificationRequired("For a committed comparison, specify a commit or branch review. Current-source reviews use the frozen working tree against HEAD.");
  plan.focus.forEach(safeRelativePath);
  if (pathFocus.length && plan.focus.some(scope => !pathFocus.some(root => scope === root || scope.startsWith(`${root}/`)))) {
    throw new ClarificationRequired("The interpreted scope extends outside the path you supplied. Which paths inside it should I review?");
  }
  const focus = plan.focus.length ? plan.focus : pathFocus;
  const unknown = focus.filter(scope => !sourcePaths.some(file => file === scope || file.startsWith(`${scope}/`)));
  if (unknown.length) throw new ClarificationRequired(`I couldn't find source under ${unknown.join(", ")}. Which paths should I focus on?`);
  return { plan, directory, options: {
    repo, base, head, workingTree, frozenSnapshots: [captured.base, captured.head], comparison: kind, reviewScope: plan.reviewScope, installDependencies: plan.installDependencies,
    focus, instructions, analyses: plan.analyses, out: output, runDirectory: directory,
    maxHypotheses: plan.maxHypotheses, maxQualityFindings: plan.maxQualityFindings,
    maxExperimentsPerHypothesis: plan.maxExperimentsPerHypothesis,
    maxCodeQualityBatches: reviewSettings.tasks.codeQuality.maxBatches,
    maxAdversarialInvestigationBatches: reviewSettings.tasks.adversarial.maxInvestigationBatches,
    assessmentConcurrency: reviewSettings.tasks.adversarial.assessmentConcurrency,
    assessmentRetries: reviewSettings.tasks.adversarial.assessmentRetries,
    probeRepairAttempts: reviewSettings.tasks.adversarial.probeRepairAttempts,
    assessmentTimeoutMs: reviewSettings.tasks.adversarial.assessmentTimeoutSeconds * 1000,
    dependencySetupTimeoutMs: reviewSettings.tasks.preflight.dependencySetupTimeoutSeconds * 1000,
    perTaskConcurrency: plan.perTaskConcurrency, agentTimeoutMs: plan.agentTimeoutSeconds * 1000,
    agentRetries: reviewSettings.agentRetries, agentRetryDelayMs: reviewSettings.agentRetryDelaySeconds * 1000,
    experimentTimeoutMs: plan.testTimeoutSeconds * 1000,
    signal: options.signal, onEvent: options.onEvent,
  } };
}
