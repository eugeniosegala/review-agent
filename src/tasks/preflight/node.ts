import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Prerequisite, ReviewContext } from "../../shared/types.ts";

/** Common Node mechanics belong to deterministic code, not generated guesses. */
export async function nodePrerequisites(context: ReviewContext): Promise<Prerequisite[]> {
  const revisions = (["base", "head"] as const).filter(revision => context.snapshots[revision].files.includes("package.json"));
  if (!revisions.length) return [];
  const script = await readFile(new URL("./node-check.mjs", import.meta.url), "utf8");
  const semverPath = createRequire(import.meta.url).resolve("semver");
  const sources = revisions.map(revision => ({ revision, path: "package.json" }));
  return ["runtime", "packages"].map(mode => ({ id: `node_${mode === "runtime" ? "toolchain" : "dependencies"}`, category: mode === "runtime" ? "runtime" : "package",
    description: mode === "runtime" ? "Available application Node runtime satisfying declared engines" : "Runtime and test-tool packages resolved from the full snapshot hierarchy",
    required: true, revisions: [...revisions], sources,
    remediation: mode === "runtime" ? "Provide an installed compatible Node runtime; an available Volta pin is selected automatically." : "Install the required dependencies in the target project's dependency environment and retry. Frozen source copies reuse that environment; do not install in each copied snapshot.",
    check: { parallelSafe: true, files: [{ path: "node-check.mjs", content: script }], argv: ["node", "{{experiments}}/node-check.mjs", mode, semverPath] },
  }));
}
