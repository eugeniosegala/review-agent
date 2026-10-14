import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createConfiguredBridge, resolveConfiguration } from "../src/config/index.ts";
import { RuntimeExecutor } from "../src/runtime/experiments.ts";
import { review } from "../src/review.ts";
import { captureWorkingTree } from "../src/runtime/working-tree.ts";
import { createFixture, duplicationFixtureBridge, FixtureBridge } from "../test/fixtures.ts";

const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false }, clean: { type: "boolean", default: false },
  duplication: { type: "boolean", default: false },
  out: { type: "string", default: "reports" },
  model: { type: "string" },
  config: { type: "string" },
  "per-task-concurrency": { type: "string", default: "2" },
} });
if (values.clean && values.duplication) throw new Error("Choose --clean or --duplication, not both");
const fixture = await createFixture(values.clean ? "clean" : values.duplication ? "duplication" : "bug");
execFileSync("git", ["-C", fixture.repo, "reset", "--soft", fixture.base]);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  console.log(values.live ? "Live Codex review of a seeded fixture." : "Offline pipeline demo: scripted bridge, real current-runtime experiments (no AI calls).");
  const workingTree = await captureWorkingTree(fixture.repo, path.join(fixture.repo, "reports", "capture"));
  const liveBridge = values.live ? await createConfiguredBridge((await resolveConfiguration([
    fixture.repo, ...(values.model ? ["--model", values.model] : []), ...(values.config ? ["--config", values.config] : []),
  ])).config) : undefined;
  const { report, directory } = await review({ ...fixture, workingTree, head: workingTree.head.commit, out: values.out, focus: [], maxHypotheses: 1,
    agentTimeoutMs: 180000, experimentTimeoutMs: 15000,
    perTaskConcurrency: Number(values["per-task-concurrency"]),
    signal: controller.signal,
    onEvent: event => console.error(event.message),
  }, liveBridge ?? (values.duplication ? duplicationFixtureBridge() : new FixtureBridge()), new RuntimeExecutor());
  console.log(`Workflow: ${report.status}`);
  console.log(`Code quality: ${report.codeQuality?.findings.length ?? 0} recommendation(s)`);
  console.log(`Adversarial findings: ${report.adversarial?.findings.map(f => f.status).join(", ") || "none"}`);
  console.log(`Report: ${path.join(directory, "report.md")}`);
  for (const error of report.errors) console.error(error);
  // This is a demonstration of finding a seeded bug, not a merge gate.
  process.exitCode = report.status === "incomplete" ? 2 : 0;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  await rm(fixture.repo, { recursive: true, force: true });
}
