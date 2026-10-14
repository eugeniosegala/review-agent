import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { captureWorkingTree, diffSnapshots } from "../src/runtime/working-tree.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";
import { planReview } from "../src/request/index.ts";
import { runCommand } from "../src/command.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";

const git = (repo: string, args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" }).trim();

test("capture includes staged, unstaged, untracked, deleted, renamed, binary, and mode changes", async t => {
  const fixture = await createFixture("clean");
  const output = await mkdtemp(path.join(os.tmpdir(), "working-tree-test-"));
  const repo = fixture.repo;
  t.after(() => Promise.all([rm(repo, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]));
  for (const file of ["staged.txt", "unstaged.txt", "deleted.txt", "old.txt", "mode.sh", "outside.txt"]) await writeFile(path.join(repo, file), "Baseline\n");
  await mkdir(path.join(repo, "reports"));
  await writeFile(path.join(repo, "reports", "component.txt"), "Tracked application content\n");
  await writeFile(path.join(repo, ".gitignore"), ".cache/\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "More baseline sources"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repo, "staged.txt"), "Staged version\n");
  git(repo, ["add", "staged.txt"]);
  await writeFile(path.join(repo, "staged.txt"), "Final on-disk version\n");
  await writeFile(path.join(repo, "unstaged.txt"), "Unstaged edit\n");
  await rm(path.join(repo, "deleted.txt"));
  git(repo, ["mv", "old.txt", "renamed.txt"]);
  await writeFile(path.join(repo, "new.bin"), Buffer.from([0, 255, 128, 10]));
  await chmod(path.join(repo, "mode.sh"), 0o755);
  await rm(path.join(repo, "outside.txt"));
  await symlink("/etc/passwd", path.join(repo, "outside.txt"));
  await writeFile(path.join(repo, ".env"), "SYNTHETIC_SECRET=never_export\n");
  await mkdir(path.join(repo, ".cache"));
  await writeFile(path.join(repo, ".cache", "ignored.txt"), "Ignored data\n");
  await writeFile(path.join(repo, "reports", "generated.txt"), "Generated output\n");
  const indexBefore = await readFile(path.join(repo, ".git", "index"));

  const captured = await captureWorkingTree(repo, path.join(output, "snapshots"));
  assert.equal(captured.base.commit, baseline);
  assert.match(captured.head.commit, /^working-tree:[a-f0-9]{64}$/);
  assert.deepEqual(captured.changedFiles, [".env", "deleted.txt", "mode.sh", "new.bin", "old.txt", "outside.txt", "renamed.txt", "staged.txt", "unstaged.txt"]);
  assert.equal(await readFile(path.join(captured.head.directory, "staged.txt"), "utf8"), "Final on-disk version\n");
  assert.equal(git(repo, ["show", ":staged.txt"]), "Staged version");
  assert.deepEqual(await readFile(path.join(captured.head.directory, "new.bin")), Buffer.from([0, 255, 128, 10]));
  assert.ok(captured.head.files.includes("reports/component.txt"));
  assert.ok(!captured.head.files.includes("reports/generated.txt"));
  assert.ok(!captured.head.files.includes("deleted.txt"));
  assert.ok(!captured.head.files.includes(".cache/ignored.txt"));
  assert.ok(captured.head.excluded.some(entry => entry.path === ".env"));
  assert.ok(captured.head.excluded.some(entry => entry.path === "outside.txt"));
  assert.deepEqual(await readFile(path.join(repo, ".git", "index")), indexBefore);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), baseline);

  const diff = await diffSnapshots(captured.base, captured.head, captured.changedFiles);
  assert.match(diff.text, /Final on-disk version/);
  assert.match(diff.text, /deleted file mode/);
  assert.match(diff.text, /new file mode/);
  assert.ok(!diff.text.includes("SYNTHETIC_SECRET"));
  assert.ok(!diff.text.includes("root:"));
});

test("symlink parents cannot export files outside the repository", async t => {
  const fixture = await createFixture("clean");
  const output = await mkdtemp(path.join(os.tmpdir(), "working-links-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]));
  await mkdir(path.join(fixture.repo, "nested"));
  await writeFile(path.join(fixture.repo, "nested", "file.txt"), "Baseline\n");
  git(fixture.repo, ["add", "."]); git(fixture.repo, ["commit", "-qm", "Nested source"]);
  await rm(path.join(fixture.repo, "nested"), { recursive: true });
  await mkdir(path.join(output, "outside"));
  await writeFile(path.join(output, "outside", "file.txt"), "Do not export\n");
  await symlink(path.join(output, "outside"), path.join(fixture.repo, "nested"));
  const capture = await captureWorkingTree(fixture.repo, path.join(output, "capture"));
  assert.ok(capture.head.excluded.some(entry => entry.path === "nested/file.txt"));
  assert.ok(!capture.head.files.includes("nested/file.txt"));
});

class UncommittedBridge extends FixtureBridge {
  override async run(request: Parameters<FixtureBridge["run"]>[0]) {
    if (request.stage === "plan") return { comparison: { kind: "working-tree", ref: null, baseRef: null }, reviewScope: "changes", installDependencies: false, focus: [], analyses: ["code-quality", "adversarial"],
      maxHypotheses: 3, maxExperimentsPerHypothesis: 1, maxQualityFindings: 5, perTaskConcurrency: 2, agentTimeoutSeconds: 180, testTimeoutSeconds: 30,
      summary: "Review uncommitted changes against HEAD.", clarification: null };
    return super.run(request);
  }
}

test("a clean working tree does not review already-committed bugs", async t => {
  const fixture = await createFixture("bug");
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  const bridge = new UncommittedBridge();
  const messages: string[] = [];
  assert.equal(await runCommand([fixture.repo, "Review my changes."], { bridge, executor: new RuntimeExecutor(), write: message => messages.push(message) }), 0);
  assert.deepEqual(bridge.stages, ["report"]);
  const reportPath = messages.find(message => message.startsWith("Report: "))!.slice(8);
  const report = JSON.parse(await readFile(path.join(path.dirname(reportPath), "report.json"), "utf8"));
  assert.equal(report.base, fixture.head);
  assert.deepEqual(report.changedFiles, []);
  assert.deepEqual(report.adversarial.findings, []);
});

test("a deleted file can be supplied as the CLI path", async t => {
  const fixture = await createFixture("clean");
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  await rm(path.join(fixture.repo, "access.mjs"));
  const { options } = await planReview(path.join(fixture.repo, "access.mjs"), "Review this deletion.", new UncommittedBridge());
  assert.deepEqual(options.focus, ["access.mjs"]);
  assert.deepEqual(options.workingTree!.changedFiles, ["access.mjs"]);
});

test("unstaged changes importing a new untracked module reproduce a real regression", async t => {
  const fixture = await createFixture("clean");
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  await writeFile(path.join(fixture.repo, "access.mjs"), "import { allowCrossTenant } from './policy.mjs';\nexport function canRead(user, document) { return user.organizationId === document.organizationId || allowCrossTenant(user); }\n");
  await writeFile(path.join(fixture.repo, "policy.mjs"), "export function allowCrossTenant(user) { return user.role === 'editor'; }\n");
  const bridge = new UncommittedBridge();
  bridge.qualityReview.examinedFiles.push("policy.mjs");
  bridge.investigation.examinedFiles.push("policy.mjs");
  const messages: string[] = [];
  assert.equal(await runCommand([fixture.repo, "Review editor access in my uncommitted changes."], { bridge, executor: new RuntimeExecutor(), write: message => messages.push(message) }), 1);
  const reportPath = messages.find(message => message.startsWith("Report: "))!.slice(8);
  const report = JSON.parse(await readFile(path.join(path.dirname(reportPath), "report.json"), "utf8"));
  assert.deepEqual(report.changedFiles, ["access.mjs", "policy.mjs"]);
  assert.equal(report.adversarial.findings[0].status, "reproduced_regression");
  assert.equal(git(fixture.repo, ["rev-parse", "HEAD"]), fixture.head);
  assert.match(await readFile(path.join(fixture.repo, "policy.mjs"), "utf8"), /user.role === 'editor'/);
});

test("working-tree capture and diff never apply repository clean filters", async t => {
  const fixture = await createFixture("clean");
  const output = await mkdtemp(path.join(os.tmpdir(), "working-filters-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]));
  await writeFile(path.join(fixture.repo, ".gitattributes"), "* filter=review-test\n");
  git(fixture.repo, ["add", "."]); git(fixture.repo, ["commit", "-qm", "Filter attributes"]);
  git(fixture.repo, ["config", "filter.review-test.clean", "false"]);
  git(fixture.repo, ["config", "filter.review-test.required", "true"]);
  await writeFile(path.join(fixture.repo, "access.mjs"), "Literal unstaged source\n");
  const capture = await captureWorkingTree(fixture.repo, path.join(output, "capture"));
  assert.equal(await readFile(path.join(capture.head.directory, "access.mjs"), "utf8"), "Literal unstaged source\n");
  assert.match((await diffSnapshots(capture.base, capture.head, capture.changedFiles)).text, /Literal unstaged source/);
});

test("an oversized untracked file is rejected before reading its contents", async t => {
  const fixture = await createFixture("clean");
  const output = await mkdtemp(path.join(os.tmpdir(), "working-limit-"));
  t.after(() => Promise.all([rm(fixture.repo, { recursive: true, force: true }), rm(output, { recursive: true, force: true })]));
  const large = path.join(fixture.repo, "large.bin");
  await writeFile(large, "");
  await truncate(large, 33 * 1024 * 1024);
  await assert.rejects(captureWorkingTree(fixture.repo, path.join(output, "capture")), /32 MiB limit/);
});
