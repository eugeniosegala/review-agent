import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { locateTarget, resolveTargetArguments } from "../src/request/target.ts";
import { runCommand } from "../src/command.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";
import type { AgentRequest } from "../src/shared/types.ts";

async function fixture(t: test.TestContext) {
  const original = await createFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "review-target-"));
  t.after(() => Promise.all([rm(original.repo, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const repo = path.join(root, "Phone Call Analysis", "audio-downloader");
  await mkdir(path.dirname(repo), { recursive: true });
  await cp(original.repo, repo, { recursive: true });
  return { root, repo };
}

test("shell-split project paths are reconstructed without swallowing the review description", async t => {
  const { root, repo } = await fixture(t);
  const args = [path.join(root, "Phone"), "Call", "Analysis/audio-downloader", "review the main branch"];
  const resolved = await resolveTargetArguments(args);
  assert.deepEqual(resolved, [repo, "review the main branch"]);
  assert.deepEqual(await locateTarget(resolved[0]!), { repo: await realpath(repo), scope: [] });
});

test("an existing non-Git prefix does not prevent recovering the actual project", async t => {
  const { root, repo } = await fixture(t);
  await mkdir(path.join(root, "Phone"));
  assert.deepEqual(await resolveTargetArguments([path.join(root, "Phone"), "Call", "Analysis/audio-downloader", "Check authorization"]), [repo, "Check authorization"]);
});

test("quoted paths and normal paths retain all description arguments", async t => {
  const { repo } = await fixture(t);
  const args = [repo, "Review authorization", "and", "reuse"];
  assert.deepEqual(await resolveTargetArguments(args), args);
});

test("multiple valid targets require a choice rather than silently reviewing a shorter path", async t => {
  const { root } = await fixture(t);
  const shorter = path.join(root, "Phone");
  await mkdir(shorter);
  execFileSync("git", ["-C", shorter, "init", "-q"]);
  await assert.rejects(resolveTargetArguments([shorter, "Call", "Analysis/audio-downloader", "Review authorization"]), /Ambiguous review path/);
});

test("invalid paths report the supplied target instead of a confusing parent-directory Git error", async t => {
  const { root } = await fixture(t);
  await assert.rejects(locateTarget(path.join(root, "missing")), error => error instanceof Error && /Could not find a Git repository for review path/.test(error.message) && /missing/.test(error.message));
});

test("the recovered path reaches the full review pipeline and current branch reaches the planner", async t => {
  const { root, repo } = await fixture(t);
  class PlanningBridge extends FixtureBridge {
    override async run(request: AgentRequest): Promise<unknown> {
      if (request.stage === "plan") {
        assert.match(request.prompt, /"branch":/);
        assert.match(request.prompt, /review the main branch/);
        return { comparison: { kind: "working-tree", ref: null, baseRef: null }, reviewScope: "changes", installDependencies: false, focus: [], analyses: ["code-quality"], maxHypotheses: 3, maxQualityFindings: 5,
          maxExperimentsPerHypothesis: 1, perTaskConcurrency: 2, agentTimeoutSeconds: 180, testTimeoutSeconds: 30, summary: "Review uncommitted changes.", clarification: null };
      }
      return super.run(request);
    }
  }
  const messages: string[] = [];
  assert.equal(await runCommand([path.join(root, "Phone"), "Call", "Analysis/audio-downloader", "review the main branch"], {
    bridge: new PlanningBridge(), executor: new RuntimeExecutor(), write: message => messages.push(message),
  }), 0);
  assert.ok(messages.find(message => message.startsWith("Report: "))!.includes(repo));
});
