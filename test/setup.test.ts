import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { review } from "../src/review.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";

test("missing local dependencies are prepared privately and used by actual adversarial probes", async t => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  const local = path.join(fixture.repo, "local-package");
  await mkdir(local);
  await writeFile(path.join(local, "package.json"), JSON.stringify({ name: "@fixture/local", version: "1.0.0", type: "module", exports: "./index.mjs", scripts: { prepare: "node build.mjs" } }));
  await writeFile(path.join(local, "build.mjs"), "import fs from 'node:fs'; fs.writeFileSync('prepared.txt', 'built');\n");
  await writeFile(path.join(local, "index.mjs"), "export const bypass = true;\n");
  await writeFile(path.join(fixture.repo, "package.json"), JSON.stringify({ type: "module", dependencies: { "@fixture/local": "file:./local-package" } }));
  await writeFile(path.join(fixture.repo, "access.mjs"), "import { bypass } from '@fixture/local';\nexport function canRead(user, document) { return user.organizationId === document.organizationId || bypass && user.role === 'editor'; }\n");
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", fixture.repo, ...args], { encoding: "utf8" }).trim();
  git(["add", "."]); git(["commit", "-qm", "Local dependency"]);
  const head = git(["rev-parse", "HEAD"]);
  const index = await readFile(path.join(fixture.repo, ".git", "index"));
  const bridge = new FixtureBridge();
  bridge.investigation.examinedFiles = ["SPEC.md", "access.mjs", "package.json", "local-package/package.json", "local-package/index.mjs", "local-package/build.mjs"];
  const { report } = await review({ repo: fixture.repo, base: head, head, focus: [], reviewScope: "all", analyses: ["adversarial"],
    out: path.join(fixture.repo, "reports"), maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: 5000 }, bridge, new RuntimeExecutor());
  assert.equal(report.preflight!.readiness, "ready", JSON.stringify(report.preflight, null, 2));
  assert.equal(report.preflight!.setup!.length, 2);
  assert.equal(report.preflight!.setup![0]!.status, "completed");
  assert.equal(report.preflight!.setup![0]!.dependencyRoot, report.preflight!.setup![1]!.dependencyRoot);
  assert.equal(await readFile(path.join(report.preflight!.setup![0]!.dependencyRoot!, "local-package", "prepared.txt"), "utf8"), "built");
  await assert.rejects(readFile(path.join(local, "prepared.txt")), /ENOENT/);
  assert.equal(report.adversarial!.findings[0]!.status, "pre_existing");
  assert.equal(report.status, "completed");
  assert.deepEqual(await readFile(path.join(fixture.repo, ".git", "index")), index);
  await assert.rejects(readFile(path.join(fixture.repo, "package-lock.json")), /ENOENT/);
  await assert.rejects(readFile(path.join(fixture.repo, "node_modules", "@fixture", "local", "package.json")), /ENOENT/);
});
