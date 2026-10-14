import type { PreflightDiscovery, PreflightResult } from "../../shared/types.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { TaskContext } from "../context.ts";
import { unique, validateExamination } from "../validation.ts";
import { preflightPrompt } from "./prompt.ts";
import { preflightSchemaFor } from "./schema.ts";
import { verifyPrerequisites } from "./checks.ts";
import { nodePrerequisites } from "./node.ts";
import { repairPreflightChecks } from "./repair.ts";
import { prepareDependencies } from "./setup.ts";

export async function runPreflight(context: TaskContext<"preflight">): Promise<PreflightResult> {
  const result: PreflightResult = { status: "incomplete", readiness: "blocked", discovery: null, checks: [], errors: [] };
  try {
    const builtins = await nodePrerequisites(context.review);
    const applicationFiles = [...new Set([...context.review.snapshots.base.files, ...context.review.snapshots.head.files])].sort();
    const discovery = await context.invoke<PreflightDiscovery>("preflight",
      preflightPrompt(await context.skill(), context.review, builtins), preflightSchemaFor(applicationFiles));
    validateExamination(discovery, applicationFiles, "Preflight file receipt");
    if (builtins.length) discovery.requirements = discovery.requirements.filter(requirement =>
      !(["runtime", "package"].includes(requirement.category) && requirement.sources.some(source => ["package.json", "package-lock.json"].includes(source.path))));
    discovery.requirements.unshift(...builtins);
    const sourceFiles = discovery.requirements.flatMap(requirement => requirement.sources.map(source => source.path));
    discovery.examinedFiles = [...new Set([...discovery.examinedFiles, ...sourceFiles])].sort();
    const examined = new Set(discovery.examinedFiles);
    discovery.skippedFiles = discovery.skippedFiles.filter(file => !examined.has(file.path));
    validateExamination(discovery, applicationFiles, "Preflight file receipt");
    unique(discovery.requirements.map(requirement => requirement.id), "Prerequisites");
    for (const requirement of discovery.requirements) {
      unique(requirement.revisions, "Prerequisite revisions");
      for (const source of requirement.sources) {
        if (!context.review.snapshots[source.revision].files.includes(source.path)) throw new Error(`Prerequisite ${requirement.id} cites unavailable source: ${source.path}`);
      }
      if (requirement.check?.argv.some(arg => arg.includes("\0")) || requirement.check?.argv[0]?.startsWith("-")) throw new Error("Invalid preflight command");
    }
    for (const revision of ["base", "head"] as const) {
      if (!discovery.requirements.some(requirement => requirement.category === "runtime" && requirement.required && requirement.revisions.includes(revision))) {
        throw new Error(`Preflight must identify a required runtime for ${revision}`);
      }
    }
    result.discovery = discovery;
    Object.assign(result, await verifyPrerequisites(context, discovery));
    result.setup = await prepareDependencies(context, result.checks);
    if (result.setup.some(setup => setup.status === "completed")) Object.assign(result, await verifyPrerequisites(context, discovery, true));
    await repairPreflightChecks(context, result);
    await context.assertUnchanged();
    result.status = result.readiness === "ready" || !result.errors.length ? "completed" : "incomplete";
  } catch (error) { result.errors.push(errorMessage(error)); result.readiness = "blocked"; }
  return result;
}
