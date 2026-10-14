import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { review } from "../src/review.ts";
import { planReview } from "../src/request/index.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { SourcePool } from "../src/runtime/source-pool.ts";
import { exportSnapshot } from "../src/runtime/repository.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";
import type { AgentRequest } from "../src/shared/types.ts";

// Count stored source bytes, skipping navigation references instead of following them.
async function sourceCopies(directory: string): Promise<string[]> {
  const copies: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) copies.push(...await sourceCopies(path.join(directory, entry.name)));
    else if (entry.isFile() && entry.name === "access.mjs") copies.push(path.join(directory, entry.name));
  }
  return copies;
}

async function fixture(t: test.TestContext) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  return fixture;
}

test("all analysis tasks share the retained freeze and probes reuse a cleaned-up source pool", async t => {
  const f = await fixture(t);
  class InspectingBridge extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (request.task !== "report") {
        assert.ok((await lstat(path.join(request.workspace, "base"))).isSymbolicLink());
        assert.ok((await lstat(path.join(request.workspace, "head"))).isSymbolicLink());
      }
      return super.run(request);
    }
  }
  const { report, directory } = await review({ ...f, out: path.join(f.repo, "reports"), focus: [], maxHypotheses: 3,
    agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, new InspectingBridge(), new RuntimeExecutor());
  assert.equal(report.status, "completed", JSON.stringify(report.errors));
  assert.equal(report.storage!.frozenSourceCopies, 2);
  assert.equal(report.storage!.executionCopiesCreated, 2);
  assert.ok(report.storage!.executionCopiesReused >= 2);
  assert.equal((await sourceCopies(directory)).length, 2);
  await assert.rejects(lstat(path.join(directory, "artifacts", "execution-workspaces")), /ENOENT/);
  for (const record of report.adversarial!.evidence) {
    const artifacts = path.dirname(record.stdoutPath);
    const reference = JSON.parse(await readFile(path.join(artifacts, "source-reference.json"), "utf8"));
    assert.equal(reference.sourceSha256, report.snapshots![record.revision].sha256);
    assert.equal(await realpath(path.join(artifacts, "source")), await realpath(report.snapshots![record.revision].directory));
    assert.ok(await readFile(record.stdoutPath, "utf8"));
  }
});

test("whole-source reviews of an identical revision retain only one source tree", async t => {
  const f = await fixture(t);
  const bridge = new FixtureBridge();
  bridge.qualityReview.examinedFiles.push("SPEC.md");
  const { report, directory } = await review({ ...f, base: f.head, head: f.head, out: path.join(f.repo, "reports"), focus: [],
    reviewScope: "all", analyses: ["code-quality"], maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed", JSON.stringify(report.errors));
  assert.equal(report.storage!.frozenSourceCopies, 1);
  assert.equal(report.storage!.executionCopiesCreated, 0);
  assert.equal((await sourceCopies(directory)).length, 1);
  assert.equal(await realpath(report.snapshots!.base.directory), await realpath(report.snapshots!.head.directory));
});

test("request freezes survive planning and are reused without another repository copy", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, "access.mjs"), "export function canRead() { return true; }\n");
  class Planner extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (request.stage === "plan") return {
        comparison: { kind: "working-tree", ref: null, baseRef: null }, reviewScope: "changes", installDependencies: false,
        focus: [], analyses: ["code-quality"], maxHypotheses: 3, maxExperimentsPerHypothesis: 1, maxQualityFindings: 5, perTaskConcurrency: 2,
        agentTimeoutSeconds: 5, testTimeoutSeconds: 5, summary: "Review edits", clarification: null,
      };
      return super.run(request);
    }
  }
  const bridge = new Planner();
  const { options } = await planReview(f.repo, "Review edits", bridge);
  const captured = options.workingTree!;
  const { report, directory } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed", JSON.stringify(report.errors));
  assert.equal(await realpath(report.snapshots!.base.directory), captured.base.directory);
  assert.equal(await realpath(report.snapshots!.head.directory), captured.head.directory);
  assert.equal((await sourceCopies(directory)).length, 2);
});

test("a modified execution copy is discarded and cannot contaminate the next lease or original source", async t => {
  const f = await fixture(t);
  const snapshot = await exportSnapshot(f.repo, f.head, path.join(f.repo, "freeze"));
  const pool = new SourcePool(path.join(f.repo, "pool"), 2);
  t.after(() => pool.close());
  const original = await readFile(path.join(snapshot.directory, "access.mjs"), "utf8");
  await assert.rejects(pool.use(snapshot, undefined, async copy => {
    await writeFile(path.join(copy.directory, "access.mjs"), "modified source");
  }), /snapshot was modified/);
  await pool.use(snapshot, undefined, async copy => {
    assert.equal(await readFile(path.join(copy.directory, "access.mjs"), "utf8"), original);
  });
  assert.equal(await readFile(path.join(snapshot.directory, "access.mjs"), "utf8"), original);
  assert.equal(pool.stats.executionCopiesCreated, 2);
  assert.equal(pool.stats.executionCopiesReused, 0);
});

test("replacing a task source reference with an identical tree still invalidates that task", async t => {
  const f = await fixture(t);
  class RetargetingBridge extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (request.task === "code-quality") {
        const alias = path.join(request.workspace, "base");
        const actual = await realpath(alias);
        await rm(alias);
        // Same bytes, different reference: hash checks alone cannot detect this change.
        await symlink(actual, alias, "dir");
      }
      return super.run(request);
    }
  }
  const { report } = await review({ ...f, out: path.join(f.repo, "reports"), focus: [], analyses: ["code-quality"],
    maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, new RetargetingBridge(), new RuntimeExecutor());
  assert.equal(report.status, "incomplete");
  assert.match(report.errors.join(), /reference was modified/);
});


test("a committed selection removes unused working-tree captures and shares identical exported content", async t => {
  const f = await fixture(t);
  const git = (args: string[]) => execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" }).trim();
  git(["commit", "--allow-empty", "-qm", "Metadata-only commit"]);
  const head = git(["rev-parse", "HEAD"]);
  await writeFile(path.join(f.repo, "access.mjs"), "uncommitted bytes outside this committed review");
  class Planner extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (request.stage === "plan") return {
        comparison: { kind: "commit", ref: head, baseRef: null }, reviewScope: "all", installDependencies: false,
        focus: [], analyses: ["code-quality"], maxHypotheses: 3, maxExperimentsPerHypothesis: 1, maxQualityFindings: 5, perTaskConcurrency: 2,
        agentTimeoutSeconds: 5, testTimeoutSeconds: 5, summary: "Review commit", clarification: null,
      };
      return super.run(request);
    }
  }
  const bridge = new Planner();
  bridge.qualityReview.examinedFiles.push("SPEC.md");
  const { options } = await planReview(f.repo, "Review the selected commit", bridge);
  const workingCapture = options.frozenSnapshots!.find(snapshot => snapshot.commit.startsWith("working-tree:"))!;
  const { report, directory } = await review(options, bridge, new RuntimeExecutor());
  assert.equal(report.status, "completed", JSON.stringify(report.errors));
  assert.notEqual(report.base, report.head);
  assert.equal(report.storage!.frozenSourceCopies, 1);
  assert.equal((await sourceCopies(directory)).length, 1);
  await assert.rejects(lstat(workingCapture.directory), /ENOENT/);
  assert.equal(await readFile(path.join(f.repo, "access.mjs"), "utf8"), "uncommitted bytes outside this committed review");
});


test("source reuse resets sibling files that could alter package resolution", async t => {
  const f = await fixture(t);
  const snapshot = await exportSnapshot(f.repo, f.head, path.join(f.repo, "freeze"));
  const pool = new SourcePool(path.join(f.repo, "pool"), 2);
  t.after(() => pool.close());
  let first = "";
  await pool.use(snapshot, undefined, async copy => {
    first = copy.directory;
    await writeFile(path.join(path.dirname(copy.directory), "package.json"), '{"type":"commonjs"}');
  });
  await pool.use(snapshot, undefined, async copy => {
    assert.equal(copy.directory, first);
    await assert.rejects(lstat(path.join(path.dirname(copy.directory), "package.json")), /ENOENT/);
  });
  assert.equal(pool.stats.executionCopiesCreated, 1);
  assert.equal(pool.stats.executionCopiesReused, 1);
});
