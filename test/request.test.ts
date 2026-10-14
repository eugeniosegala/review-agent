import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/command.ts";
import { planReview, ClarificationRequired } from "../src/request/index.ts";
import type { ReviewPlan } from "../src/request/schema.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { review } from "../src/review.ts";
import type { AgentRequest } from "../src/shared/types.ts";
import { defaultReviewSettings } from "../src/config/schema.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";

class PlanningBridge extends FixtureBridge {
  requests: AgentRequest[] = [];
  plan: ReviewPlan;
  beforePlan?: () => void;
  constructor() {
    super();
    this.plan = { comparison: { kind: "working-tree", ref: null, baseRef: null }, reviewScope: "changes", installDependencies: false, focus: [], analyses: ["code-quality", "adversarial"],
      maxHypotheses: 3, maxExperimentsPerHypothesis: 1, maxQualityFindings: 5, perTaskConcurrency: 2, agentTimeoutSeconds: 180, testTimeoutSeconds: 30,
      summary: "Review uncommitted access changes against HEAD.", clarification: null };
  }
  override async run(request: AgentRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.stage === "plan") { this.beforePlan?.(); return structuredClone(this.plan); }
    return super.run(request);
  }
}

async function fixture(t: test.TestContext) {
  const result = await createFixture();
  execFileSync("git", ["-C", result.repo, "reset", "--soft", result.base]);
  t.after(() => rm(result.repo, { recursive: true, force: true }));
  return { ...result, bridge: new PlanningBridge() };
}

test("a path and natural language reach every review stage and produce real regression evidence", async t => {
  const { repo, bridge } = await fixture(t);
  const messages: string[] = [];
  const description = "Review uncommitted changes; try cross-tenant editor access and check reuse.";
  const indexPath = path.join(repo, ".git", "index");
  const indexBefore = await readFile(indexPath);
  const sourceBefore = await readFile(path.join(repo, "access.mjs"));
  const exit = await runCommand([repo, description], { bridge, executor: new RuntimeExecutor(), write: message => messages.push(message) });
  assert.equal(exit, 1);
  assert.equal(bridge.requests[0]?.stage, "plan");
  for (const stage of ["code-quality", "investigate", "generate", "assess", "report"]) {
    assert.ok(bridge.requests.find(request => request.stage === stage)?.prompt.includes(JSON.stringify(description)), stage);
  }
  const reportPath = messages.find(message => message.startsWith("Report: "))!.slice(8);
  const report = JSON.parse(await readFile(path.join(path.dirname(reportPath), "report.json"), "utf8"));
  const runDirectory = path.dirname(reportPath);
  assert.deepEqual(await readdir(path.join(repo, "reports")), [path.basename(runDirectory)]);
  assert.equal(report.runId, path.basename(runDirectory));
  const planRequest = bridge.requests[0]!;
  assert.equal(planRequest.workspace, path.join(runDirectory, "artifacts", "request", "context"));
  assert.equal(planRequest.artifacts, path.join(runDirectory, "artifacts", "request", "agent"));
  const savedPlan = JSON.parse(await readFile(path.join(runDirectory, "artifacts", "request", "plan.json"), "utf8"));
  assert.equal(savedPlan.workingTree, report.head);
  assert.equal(report.instructions, description);
  assert.equal(report.adversarial.findings[0].status, "reproduced_regression");
  assert.deepEqual(report.adversarial.evidence.map((e: { outcome: string }) => e.outcome), ["pass", "violation"]);
  assert.match(report.head, /^working-tree:[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.deepEqual(await readFile(path.join(repo, "access.mjs")), sourceBefore);
});

test("natural-language task selection skips the other analysis without marking review incomplete", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.analyses = ["code-quality"];
  const messages: string[] = [];
  assert.equal(await runCommand([repo, "Only check duplication."], { bridge, executor: new RuntimeExecutor(), write: message => messages.push(message) }), 0);
  assert.deepEqual(bridge.stages, ["code-quality", "report"]);
  const reportPath = messages.find(message => message.startsWith("Report: "))!.slice(8);
  const report = JSON.parse(await readFile(path.join(path.dirname(reportPath), "report.json"), "utf8"));
  assert.equal(report.tasks.find((task: { name: string }) => task.name === "adversarial").status, "skipped");
  const adversarialReport = await readFile(path.join(path.dirname(reportPath), "tasks", "adversarial.md"), "utf8");
  assert.match(adversarialReport, /Adversarial analysis was skipped/);
  assert.match(adversarialReport, /\| access\.mjs \| skipped \|/);
  assert.match(await readFile(path.join(path.dirname(reportPath), "tasks", "code-quality.md"), "utf8"), /\| access\.mjs \| examined \|/);
});

test("path-only command uses an interactive description when provided, otherwise the default goal", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.analyses = ["code-quality"];
  await runCommand([repo], { bridge, executor: new RuntimeExecutor(), write: () => {}, describe: async () => "Check responsibility boundaries." });
  assert.match(bridge.requests[0]!.prompt, /Check responsibility boundaries/);
  bridge.requests = [];
  await runCommand([repo], { bridge, executor: new RuntimeExecutor(), write: () => {} });
  assert.match(bridge.requests[0]!.prompt, /Review my uncommitted changes/);
});

test("configured review budgets become planner defaults", async t => {
  const { repo, bridge } = await fixture(t);
  await planReview(repo, "Review this project.", bridge, { reviewSettings: {
    perTaskConcurrency: 4,
    agentTimeoutSeconds: 240,
    agentRetries: 2,
    agentRetryDelaySeconds: 0,
    tasks: {
      preflight: { ...defaultReviewSettings.tasks.preflight, installDependencies: false },
      codeQuality: { ...defaultReviewSettings.tasks.codeQuality, enabled: false, maxFindingsPerBatch: 14 },
      adversarial: { ...defaultReviewSettings.tasks.adversarial, maxHypotheses: 9, maxExperimentsPerHypothesis: 2, probeTimeoutSeconds: 45 },
    },
  } });
  const prompt = bridge.requests[0]!.prompt;
  assert.match(prompt, /analyses: \["adversarial"\]/);
  assert.match(prompt, /installDependencies: false/);
  assert.match(prompt, /maxHypotheses: 9; maxExperimentsPerHypothesis: 2;\s+maxQualityFindings: 14/);
  assert.match(prompt, /perTaskConcurrency: 4/);
  assert.match(prompt, /agentTimeoutSeconds: 240; testTimeoutSeconds: 45/);
  assert.equal(bridge.requests[0]!.timeoutMs, 240000);
});

test("a file path constrains scope even when the planner returns all paths", async t => {
  const { repo, bridge } = await fixture(t);
  const { options } = await planReview(path.join(repo, "access.mjs"), "Review this file.", bridge);
  assert.equal(options.repo, await realpath(repo));
  assert.deepEqual(options.focus, ["access.mjs"]);
  bridge.plan.focus = ["SPEC.md"];
  await assert.rejects(planReview(path.join(repo, "access.mjs"), "Review this file.", bridge), /extends outside/);
});

test("comparison overrides, unsafe paths, and excessive budgets stop at planning", async t => {
  const { repo, bridge } = await fixture(t);
  const valid = structuredClone(bridge.plan);
  for (const changes of [{ base: "missing-branch" }, { focus: ["../escape"] }, { perTaskConcurrency: 100 }, { testTimeoutSeconds: 0 }]) {
    bridge.plan = { ...valid, ...changes };
    await assert.rejects(planReview(repo, "Review this branch.", bridge), /invalid shape|Unsafe relative path/);
  }
  assert.deepEqual(bridge.stages, []);
  bridge.plan = { ...valid, analyses: ["adversarial", "adversarial"] };
  await assert.rejects(planReview(repo, "Review this branch.", bridge), /duplicate analyses/);
});

test("an invented focus cannot turn a review into an empty successful comparison", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.focus = ["authorization"];
  await assert.rejects(planReview(repo, "Focus on authorization.", bridge), ClarificationRequired);
  assert.deepEqual(bridge.stages, []);
});

test("interactive clarification becomes part of the goal before any analysis starts", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.analyses = ["code-quality"];
  bridge.plan.clarification = "Which baseline should I use?";
  const messages: string[] = [];
  const frozenSource = await readFile(path.join(repo, "access.mjs"), "utf8");
  const exit = await runCommand([repo, "Review the change."], {
    bridge, executor: new RuntimeExecutor(), write: message => messages.push(message),
    clarify: async question => {
      assert.equal(question, bridge.plan.clarification);
      assert.deepEqual(bridge.stages, []);
      await writeFile(path.join(repo, "access.mjs"), "export function canRead() { return false; }\n");
      bridge.plan.clarification = null;
      return "Review the uncommitted changes against HEAD.";
    },
  });
  assert.equal(exit, 0);
  assert.equal(bridge.requests.filter(request => request.stage === "plan").length, 2);
  assert.match(bridge.requests.find(request => request.stage === "code-quality")!.prompt, /uncommitted changes against HEAD/);
  const planningRequests = bridge.requests.filter(request => request.stage === "plan");
  assert.equal(planningRequests[0]!.workspace, planningRequests[1]!.workspace);
  const directory = path.dirname(messages.find(message => message.startsWith("Report: "))!.slice(8));
  assert.deepEqual(await readdir(path.join(repo, "reports")), [path.basename(directory)]);
  const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  assert.equal(await readFile(path.join(report.snapshots.head.directory, "access.mjs"), "utf8"), frozenSource);
});

test("an ambiguous request asks for clarification before analysis", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.clarification = "This CLI reviews uncommitted changes against HEAD. Would you like that review?";
  await assert.rejects(planReview(repo, "Review against the release branch.", bridge), error => error instanceof ClarificationRequired && /uncommitted changes/.test(error.message));
  assert.deepEqual(bridge.stages, []);
});

test("working-tree bytes and baseline stay frozen when source and HEAD move during planning", async t => {
  const { repo, base, head, bridge } = await fixture(t);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" }).trim();
  bridge.beforePlan = () => {
    writeFileSync(path.join(repo, "access.mjs"), "export function canRead(user, document) { return false; }\n");
    git(["reset", "--soft", head]);
  };
  const { options } = await planReview(repo, "Review my uncommitted changes.", bridge);
  assert.equal(options.base, base);
  assert.match(options.head, /^working-tree:/);
  assert.match(await readFile(path.join(options.workingTree!.head.directory, "access.mjs"), "utf8"), /user.role === 'editor'/);
  assert.match(await readFile(path.join(repo, "access.mjs"), "utf8"), /return false/);
});

test("a requested commit is pinned and compared with its first parent without changing the checkout", async t => {
  const { repo, base, head, bridge } = await fixture(t);
  bridge.plan.comparison = { kind: "commit", ref: head, baseRef: null };
  const indexBefore = await readFile(path.join(repo, ".git", "index"));
  const sourceBefore = await readFile(path.join(repo, "access.mjs"));
  const { options } = await planReview(repo, `Review commit ${head}.`, bridge);
  assert.equal(options.base, base);
  assert.equal(options.head, head);
  assert.equal(options.workingTree, undefined);
  const { report } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed");
  assert.equal(report.comparison, "commit");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.deepEqual(await readFile(path.join(repo, ".git", "index")), indexBefore);
  assert.deepEqual(await readFile(path.join(repo, "access.mjs")), sourceBefore);
});

test("a full repository request examines unchanged source as well as uncommitted files", async t => {
  const { repo, bridge } = await fixture(t);
  bridge.plan.comparison = { kind: "repository", ref: null, baseRef: null };
  bridge.plan.reviewScope = "all";
  bridge.plan.analyses = ["code-quality"];
  bridge.qualityReview.examinedFiles.push("SPEC.md");
  const { options } = await planReview(repo, "Review the entire repository for repeated strings; code quality only.", bridge);
  const { report } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedFiles, ["access.mjs"]);
  assert.deepEqual(report.reviewFiles, ["SPEC.md", "access.mjs"]);
  assert.equal(report.codeQuality!.coverage.find(entry => entry.path === "SPEC.md")!.status, "examined");
});

test("a branch review without a baseline inspects its pinned tree and labels existing defects correctly", async t => {
  const { repo, head, bridge } = await fixture(t);
  execFileSync("git", ["-C", repo, "branch", "review-target", head]);
  const originalHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  bridge.plan.comparison = { kind: "branch", ref: "review-target", baseRef: null };
  bridge.plan.reviewScope = "all";
  bridge.qualityReview.examinedFiles.push("SPEC.md");
  bridge.investigation.examinedFiles.push("SPEC.md");
  const { options } = await planReview(repo, "Review the review-target branch.", bridge);
  assert.equal(options.base, head);
  assert.equal(options.head, head);
  execFileSync("git", ["-C", repo, "branch", "-f", "review-target", options.base + "^"]);
  const { report } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed");
  assert.equal(report.head, head);
  assert.equal(report.adversarial!.findings[0]!.status, "pre_existing");
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }), originalHead);
});

test("an unchanged file can be reviewed in full without widening its supplied path", async t => {
  const { repo, base, bridge } = await fixture(t);
  await writeFile(path.join(repo, "access.mjs"), execFileSync("git", ["-C", repo, "show", `${base}:access.mjs`]));
  bridge.plan.comparison = { kind: "repository", ref: null, baseRef: null };
  bridge.plan.reviewScope = "all";
  bridge.plan.analyses = ["code-quality"];
  const { options } = await planReview(path.join(repo, "access.mjs"), "Review this entire file for constants.", bridge);
  const { report } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed");
  assert.deepEqual(report.changedFiles, []);
  assert.deepEqual(report.reviewFiles, ["access.mjs"]);
});

test("help runs without invoking an agent", async () => {
  const bridge = new PlanningBridge();
  const messages: string[] = [];
  assert.equal(await runCommand(["--help"], { bridge, executor: new RuntimeExecutor(), write: message => messages.push(message) }), 0);
  assert.match(messages[0]!, /review-agent PATH/);
  assert.deepEqual(bridge.requests, []);
});

test("the executable command works through a symlink from another project", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "review-agent");
  await symlink(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), command);
  assert.match(execFileSync(command, ["--help"], { cwd: directory, encoding: "utf8" }), /Usage: review-agent PATH/);
});
