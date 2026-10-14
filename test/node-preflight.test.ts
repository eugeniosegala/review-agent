import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { nodeToolchain } from "../src/runtime/node-toolchain.ts";
import { review } from "../src/review.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";
import type { AgentRequest } from "../src/shared/types.ts";

async function run(t: test.TestContext, manifest: object, prepare?: (repo: string) => Promise<void>, bridge = new FixtureBridge(), installDependencies = true) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  await writeFile(path.join(fixture.repo, "package.json"), JSON.stringify(manifest));
  if (prepare) await prepare(fixture.repo);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", fixture.repo, ...args], { encoding: "utf8" }).trim();
  git(["add", "package.json", "access.mjs"]); git(["commit", "-qm", "Application setup"]);
  bridge.qualityReview.examinedFiles.push("package.json");
  bridge.investigation.examinedFiles.push("package.json");
  return { ...await review({ repo: fixture.repo, base: fixture.base, head: git(["rev-parse", "HEAD"]),
    out: path.join(fixture.repo, "reports"), focus: [], installDependencies, maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, bridge, new RuntimeExecutor()), repo: fixture.repo };
}

test("export-hidden package metadata and core-module dependencies resolve above frozen copies", async t => {
  const { report } = await run(t, { dependencies: { "@fixture/hidden": "1.0.0" }, devDependencies: { prettier: "1.0.0" } }, async repo => {
    const directory = path.join(repo, "node_modules", "@fixture", "hidden");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@fixture/hidden", version: "1.0.0", exports: "./index.mjs", dependencies: { events: "^3.0.0" } }));
    await writeFile(path.join(directory, "index.mjs"), "export const installed = true;");
  });
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "node_dependencies")!.outcome, "available");
  assert.equal(report.status, "completed");
  assert.deepEqual(report.preflight!.setup, []);
});

test("a missing runtime package still reaches the actual probe and remains a setup failure", async t => {
  const { report } = await run(t, { dependencies: { "@fixture/absent": "1.0.0" } }, async repo => {
    await writeFile(path.join(repo, "access.mjs"), "import '@fixture/absent';\nexport function canRead() { return false; }\n");
  }, new FixtureBridge(), false);
  assert.equal(report.preflight!.readiness, "blocked");
  assert.deepEqual(report.adversarial!.evidence.map(record => record.outcome), ["pass", "error"]);
  assert.equal(report.adversarial!.findings[0]!.status, "inconclusive");
  assert.equal(report.status, "incomplete");
});

test("an unavailable development pin is not treated as an engine incompatibility", async t => {
  const { report } = await run(t, { volta: { node: "99.0.0" }, engines: { node: ">=18" } });
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "node_toolchain")!.outcome, "available");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
});

test("genuine engine incompatibility is reported while execution is still attempted", async t => {
  const { report } = await run(t, { engines: { node: ">=99" } });
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "node_toolchain")!.outcome, "missing");
  assert.equal(report.adversarial!.evidence.length, 2);
});

test("runtime selection prefers an installed pin without switching the review service", async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  const pin = process.versions.node;
  const root = path.join(fixture.repo, "fake-volta");
  const executable = path.join(root, "tools", "image", "node", pin, "bin", "node");
  await mkdir(path.dirname(executable), { recursive: true });
  await symlink(process.execPath, executable);
  await writeFile(path.join(fixture.repo, "package.json"), JSON.stringify({ volta: { node: pin } }));
  const selected = await nodeToolchain(fixture.repo, { voltaHome: root, path: "", executable: process.execPath });
  assert.equal(selected.executable, executable);
  assert.equal(selected.version, pin);
  assert.equal(process.versions.node, pin);
});

test("failed preflight discovery does not prevent adversarial execution", async t => {
  class FailedPreflight extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (request.stage === "preflight") throw new Error("Preflight discovery failed");
      return super.run(request);
    }
  }
  const { report, directory } = await run(t, {}, undefined, new FailedPreflight());
  assert.equal(report.preflight!.status, "incomplete");
  assert.equal(report.adversarial!.evidence.length, 2);
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.match(await readFile(path.join(directory, "tasks", "adversarial.md"), "utf8"), /checks are advisory/);
});

test("failed dependency installation remains advisory and actual probes still execute", async t => {
  const { report } = await run(t, { dependencies: { "@fixture/unavailable": "file:./missing-local-package" }, scripts: { preinstall: "node -e \"process.exit(7)\"" } });
  assert.equal(report.preflight!.setup![0]!.status, "incomplete", JSON.stringify(report.preflight!.setup, null, 2));
  assert.equal(report.preflight!.setup![0]!.dependencyRoot, null);
  assert.notEqual(report.preflight!.setup![0]!.result!.exitCode, 0);
  assert.deepEqual(report.adversarial!.evidence.map(record => record.outcome), ["pass", "violation"]);
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
});
