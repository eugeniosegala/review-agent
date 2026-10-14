import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Investigation, JsonSchema, ReviewContext, ReviewOptions, Snapshot } from "../src/shared/types.ts";
import type { TaskContext } from "../src/tasks/context.ts";
import { investigateSource } from "../src/tasks/adversarial/investigate.ts";

test("adversarial investigation batches source concurrently and enforces one global hypothesis budget", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adversarial-batches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["src/a/a.mjs", "src/b/b.mjs", "src/c/c.mjs"];
  const source = `${"export const value = 'bounded adversarial source';\n".repeat(900)}`;
  const snapshots = {} as Record<"base" | "head", Snapshot>;
  for (const revision of ["base", "head"] as const) {
    const directory = path.join(root, revision);
    for (const file of files) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), source);
    }
    snapshots[revision] = { commit: revision, directory, files, excluded: [], sha256: revision };
  }
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const review: ReviewContext = { repo: root, base: "base", head: "head", changedFiles: files,
    snapshots, diffTruncated: false, workspace, directory: root };
  const options = { maxHypotheses: 2, perTaskConcurrency: 3, maxAdversarialInvestigationBatches: 8 } as ReviewOptions;
  let active = 0;
  let maximum = 0;
  const severity = { batch_1: "low", batch_2: "high", batch_3: "medium" } as const;
  const context = {
    task: "adversarial", review, options, executor: {} as TaskContext<"adversarial">["executor"],
    skill: async () => "skill", assertUnchanged: async () => {},
    async invoke<TResult>(_stage: "investigate", _prompt: string, schema: JsonSchema, artifactId?: string): Promise<TResult> {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 50));
      active--;
      const selected = ((schema.properties as Record<string, { items: { enum: string[] } }>).examinedFiles!.items.enum);
      return { hypotheses: [{ id: "shared", title: artifactId!, severity: severity[artifactId as keyof typeof severity],
        claim: "A behavior may violate its contract.", invariant: "The contract must hold.", expectationSource: "Established baseline behavior.",
        changedFiles: [selected[0]!], testIdea: "Execute the boundary." }], examinedFiles: selected, skippedFiles: [], notes: [] } as TResult;
    },
  } satisfies TaskContext<"adversarial">;

  const result = await investigateSource(context, "skill");
  assert.equal(maximum, 3);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.investigation.examinedFiles, files);
  assert.deepEqual(result.investigation.hypotheses.map(item => item.severity), ["high", "medium"]);
  assert.equal(new Set(result.investigation.hypotheses.map(item => item.id)).size, 2);
  assert.match(result.investigation.notes.join("\n"), /global 2-hypothesis budget/);
});
