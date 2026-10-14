import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { review } from "../src/review.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import type { AgentRequest, Prerequisite } from "../src/shared/types.ts";
import { createFixture, FixtureBridge } from "./fixtures.ts";

const git = (repo: string, args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" }).trim();

async function run(t: test.TestContext, bridge = new FixtureBridge(), prepare?: (repo: string) => Promise<void>, timeout = 5000) {
  const fixture = await createFixture();
  t.after(() => rm(fixture.repo, { recursive: true, force: true }));
  if (prepare) await prepare(fixture.repo);
  const head = git(fixture.repo, ["rev-parse", "HEAD"]);
  const result = await review({ repo: fixture.repo, base: fixture.base, head, out: path.join(fixture.repo, "reports"),
    focus: [], maxHypotheses: 3, agentTimeoutMs: 5000, experimentTimeoutMs: timeout }, bridge, new RuntimeExecutor());
  return { ...result, bridge, fixture };
}

function requirement(overrides: Partial<Prerequisite> = {}): Prerequisite {
  return { id: "application_package", category: "package", description: "Application runtime package", required: true,
    revisions: ["head"], sources: [{ revision: "head", path: "access.mjs" }],
    remediation: "Install the application's declared dependencies in the test environment.", check: null, ...overrides };
}

const packageCheck: NonNullable<Prerequisite["check"]> = {
  parallelSafe: true, argv: ["node", "{{experiments}}/package.mjs"], files: [{ path: "package.mjs", content:
    `import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.env.REVIEW_REPO, 'package.json'));
let status = 'pass', actual;
try { actual = require.resolve('@review-fixture/present'); }
catch(error) { status = error.code === 'MODULE_NOT_FOUND' ? 'violation' : 'error'; actual = error.code ?? String(error); }
console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status, expected:'Resolvable application package', actual, details:status === 'pass' ? 'Application package resolves from the probe source' : 'Application package is unavailable' }));
process.exitCode = status === 'pass' ? 0 : status === 'violation' ? 1 : 2;
` }],
};

test("verified prerequisites are provided before probe generation and assessment", async t => {
  class ObservingBridge extends FixtureBridge {
    override async run(request: AgentRequest) {
      if (["generate", "assess"].includes(request.stage)) {
        const preflight = JSON.parse(await readFile(path.join(request.workspace, "preflight-context.json"), "utf8"));
        assert.equal(preflight.readiness, "ready");
        assert.deepEqual(preflight.checks.map((check: { outcome: string }) => check.outcome), ["available", "available"]);
      }
      return super.run(request);
    }
  }
  const { report } = await run(t, new ObservingBridge());
  assert.equal(report.status, "completed");
  assert.ok(report.tasks.find(task => task.name === "preflight")!.finishedAt! <= report.tasks.find(task => task.name === "adversarial")!.finishedAt!);
});

test("missing-package diagnostics are advisory and adversarial execution still runs", async t => {
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ check: packageCheck }));
  const { report, directory } = await run(t, bridge);
  assert.equal(report.status, "completed");
  assert.equal(report.preflight!.readiness, "blocked");
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "application_package")!.outcome, "missing");
  assert.ok(bridge.stages.includes("investigate"));
  assert.equal(report.codeQuality!.status, "completed");
  assert.equal(report.reporting!.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.deepEqual(report.adversarial!.evidence.map(record => record.outcome), ["pass", "violation"]);
  assert.match(await readFile(path.join(directory, "tasks", "preflight.md"), "utf8"), /Install the application's declared dependencies/);
  assert.match(await readFile(path.join(directory, "tasks", "adversarial.md"), "utf8"), /checks are advisory/);
});

test("packages installed above copied snapshots are usable by preflight and real adversarial probes", async t => {
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ check: packageCheck, sources: [{ revision: "head", path: "package.json" }] }));
  bridge.qualityReview.examinedFiles.push("package.json");
  bridge.investigation.examinedFiles.push("package.json");
  const { report } = await run(t, bridge, async repo => {
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ type: "module", dependencies: { "@review-fixture/present": "1.0.0" } }));
    await writeFile(path.join(repo, "access.mjs"), "import { bypass } from '@review-fixture/present';\nexport function canRead(user, document) { return user.organizationId === document.organizationId || bypass && user.role === 'editor'; }\n");
    git(repo, ["add", "package.json", "access.mjs"]); git(repo, ["commit", "-qm", "Application package import"]);
    const installed = path.join(repo, "node_modules", "@review-fixture", "present");
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, "package.json"), JSON.stringify({ name: "@review-fixture/present", version: "1.0.0", type: "module", exports: "./index.mjs" }));
    await writeFile(path.join(installed, "index.mjs"), "export const bypass = true;\n");
  });
  assert.equal(report.preflight!.readiness, "ready");
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
});

test("an unsupported optional integration does not block module-level probes", async t => {
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ id: "optional_database", category: "service", required: false,
    description: "Database needed only for full integration tests", remediation: "Provide an isolated test database for integration coverage." }));
  const { report } = await run(t, bridge);
  assert.equal(report.preflight!.readiness, "ready");
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "optional_database")!.outcome, "unknown");
  assert.equal(report.status, "completed");
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
});

test("required configuration is checked in the probe environment without inheriting host secrets", async t => {
  const previous = process.env.REVIEW_TEST_PREFLIGHT_SECRET;
  process.env.REVIEW_TEST_PREFLIGHT_SECRET = "synthetic-private-value";
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_TEST_PREFLIGHT_SECRET; else process.env.REVIEW_TEST_PREFLIGHT_SECRET = previous; });
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ id: "test_config", category: "configuration", check: {
    parallelSafe: true, argv: ["node", "{{experiments}}/config.mjs"], files: [{ path: "config.mjs", content:
      `const present = !!process.env.REVIEW_TEST_PREFLIGHT_SECRET;
console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({ status:present?'pass':'violation',expected:'Configured test environment',actual:present?'present':'absent',details:'Only configuration presence is reported' }));
process.exitCode = present ? 0 : 1;` }],
  } }));
  const { report, directory } = await run(t, bridge);
  assert.equal(report.preflight!.readiness, "blocked");
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "test_config")!.outcome, "missing");
  assert.ok(!(await readFile(path.join(directory, "report.json"), "utf8")).includes("synthetic-private-value"));
});

test("crashed and unsupported required checks stay unknown rather than becoming defects", async t => {
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ check: { parallelSafe: true, files: [{ path: "crash.mjs", content: "throw new Error('readiness failed');" }], argv: ["node", "{{experiments}}/crash.mjs"] } }));
  const { report } = await run(t, bridge);
  assert.equal(report.preflight!.readiness, "blocked");
  assert.equal(report.preflight!.checks.find(check => check.requirementId === "application_package")!.outcome, "unknown");
  assert.ok(bridge.stages.includes("investigate"));
  assert.equal(report.adversarial!.findings[0]!.hypothesis.id, "tenant_boundary");
});


test("a cache-writing readiness check is rejected, repaired once, and rerun against clean source", async t => {
  const cacheCheck = (scratch: boolean) => ({ parallelSafe: true, argv: ["node", "{{experiments}}/cache.mjs"], files: [{ path: "cache.mjs", content: `
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.join(process.env.${scratch ? "REVIEW_SCRATCH" : "REVIEW_REPO"}, '.cache', 'results.json');
await mkdir(path.dirname(output), {recursive:true});
await writeFile(output, '{"tests":"passed"}');
console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({status:'pass', expected:'Readiness check executes', actual:'Check passed', details:'Real check output was written'}));
` }] });
  class RepairingBridge extends FixtureBridge {
    repairs = 0;
    override async run(request: AgentRequest) {
      if (request.artifacts.endsWith("check-repair")) {
        this.repairs++;
        assert.match(request.prompt, /added paths: .cache\/results.json/);
        return { repairs: [{ requirementId: "cache_check", check: cacheCheck(true) }] };
      }
      return super.run(request);
    }
  }
  const bridge = new RepairingBridge();
  bridge.preflight.requirements.push(requirement({ id: "cache_check", category: "build", revisions: ["base", "head"], check: cacheCheck(false) }));
  const { report, directory } = await run(t, bridge);
  assert.equal(bridge.repairs, 1);
  assert.equal(report.status, "completed", report.errors.join());
  assert.equal(report.preflight!.readiness, "ready");
  assert.deepEqual(report.preflight!.errors, []);
  assert.ok(report.preflight!.checks.filter(check => check.requirementId === "cache_check").every(check => check.outcome === "available"));
  assert.match(report.preflight!.discovery!.notes.join(), /bounded repair/);
  await assert.rejects(readFile(path.join(report.snapshots!.head.directory, '.cache', 'results.json')), /ENOENT/);
  assert.equal(report.adversarial!.findings[0]!.status, "reproduced_regression");
  assert.match(await readFile(path.join(directory,'tasks','preflight.md'), 'utf8'), /available/);
});
