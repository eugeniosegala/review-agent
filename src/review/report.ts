import path from "node:path";
import type { AgentBridge, ReviewOptions, ReviewReport } from "../shared/types.ts";
import type { ResolvedReviewOptions } from "./options.ts";
import { createTaskRuns } from "./task-runner.ts";

const limitations = [
  "This is a bounded review, not a proof of correctness or security. Code-quality recommendations are advisory.",
  "Agent-reported file examination is not measured execution coverage.",
  "License and notice text, generated dependency locks, binary assets, and directory placeholders remain in snapshots but are excluded from static source examination. Setup checks inspect dependency metadata.",
  "Agent bridges use read-only review instructions and provider-specific tool restrictions. Snapshot-integrity checks reject source mutations; the deployment environment owns isolation, filesystem access, resource policies, and credentials.",
  "Repository instructions, potential secret files, symlinks, and submodules are excluded from snapshots. Required tools and dependencies must already be available.",
  "Experiments run in the current deployment environment, with separate snapshots, child processes, and scratch directories.",
];

export function createReviewReport(options: ReviewOptions, bridge: AgentBridge, directory: string, resolved: ResolvedReviewOptions): ReviewReport {
  return {
    version: 2,
    runId: path.basename(directory),
    bridge: bridge.name,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    repo: path.resolve(options.repo),
    base: options.base,
    head: options.head,
    focus: options.focus,
    instructions: options.instructions,
    changedFiles: [],
    reviewFiles: [],
    reviewScope: resolved.reviewScope,
    comparison: resolved.comparison,
    timings: { preparationMs: 0, totalMs: 0, agentCalls: [] },
    snapshots: null,
    diffTruncated: false,
    preflight: null,
    codeQuality: null,
    adversarial: null,
    reporting: null,
    errors: [],
    tasks: createTaskRuns(resolved.analyses),
    limitations: [...limitations],
  };
}
