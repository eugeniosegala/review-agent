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

test("startup readiness can launch the application and leave no background server behind", { skip: process.platform === "win32" }, async t => {
  const bridge = new FixtureBridge();
  bridge.preflight.requirements.push(requirement({ id: "server_startup", category: "startup", sources: [{ revision: "head", path: "server.mjs" }], check: {
    parallelSafe: true, argv: ["node", "{{experiments}}/startup.mjs"], files: [{ path: "startup.mjs", content:
      `import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(process.execPath, [path.join(process.env.REVIEW_REPO, 'server.mjs')], { stdio:['ignore','ignore','ignore','ipc'] });
const { port } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
const response = await fetch('http://127.0.0.1:' + port + '/health');
console.log('REVIEW_AGENT_OBSERVATION:' + JSON.stringify({status:response.status===200?'pass':'violation',expected:'Healthy startup',actual:String(response.status),details:'server pid=' + child.pid}));
process.exit(response.status===200?0:1);
` }],
  } }));
  bridge.qualityReview.examinedFiles.push("server.mjs");
  bridge.investigation.examinedFiles.push("server.mjs");
  const { report } = await run(t, bridge, async repo => {
    await writeFile(path.join(repo, "server.mjs"), "import http from 'node:http';\nconst server = http.createServer((req,res)=>{ res.writeHead(200); res.end('ready'); });\nserver.listen(0, '127.0.0.1', ()=>process.send({ port:server.address().port }));\n");
    git(repo, ["add", "server.mjs"]); git(repo, ["commit", "-qm", "Health endpoint"]);
  });
  const check = report.preflight!.checks.find(item => item.requirementId === "server_startup")!;
  assert.equal(check.outcome, "available", JSON.stringify(check, null, 2));
  const pid = Number(/pid=(\d+)/.exec(check.reason)![1]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(report.status, "completed");
});
