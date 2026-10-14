import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { cloneDirectory } from "../../runtime/source.ts";
import { nodeToolchain } from "../../runtime/node-toolchain.ts";
import { minimalEnvironment, runProcess, successful } from "../../runtime/process.ts";
import type { PreflightResult } from "../../shared/types.ts";
import type { TaskContext } from "../context.ts";
import { errorMessage } from "../../shared/errors.ts";

/** Reuse working dependencies; install only after an observed package problem, in a private copy. */
export async function prepareDependencies(context: TaskContext<"preflight">, checks: PreflightResult["checks"]): Promise<NonNullable<PreflightResult["setup"]>> {
  if (context.options.installDependencies === false) return [];
  const revisions = [...new Set(checks.filter(check => check.requirementId === "node_dependencies" && check.outcome === "missing" &&
    (check.reason.includes("MODULE_NOT_FOUND") || /installed .+?, (locked|required)/.test(check.reason))).map(check => check.revision))];
  const results: NonNullable<PreflightResult["setup"]> = [];
  const prepared = new Map<string, NonNullable<PreflightResult["setup"]>[number]>();
  for (const revision of revisions) {
    const snapshot = context.review.snapshots[revision];
    const directory = path.join(context.review.directory, "artifacts", "tasks", "preflight", "setup", revision);
    let result: NonNullable<PreflightResult["setup"]>[number] = { revision, directory, status: "incomplete", dependencyRoot: null, reason: "Setup was not completed.", result: null };
    try {
      const manifest = await readFile(path.join(snapshot.directory, "package.json"), "utf8");
      let lock = "";
      try { lock = await readFile(path.join(snapshot.directory, "package-lock.json"), "utf8"); } catch { /* npm install when no npm lockfile exists. */ }
      const node = await nodeToolchain(snapshot.directory);
      const key = createHash("sha256").update(manifest).update(lock).update(node.version)
        .update(/"(?:file:|link:|workspace:)|"workspaces"/.test(manifest) ? snapshot.sha256 : "").digest("hex");
      if (prepared.has(key)) {
        const previous = prepared.get(key)!;
        result = { ...previous, revision, reason: previous.status === "completed" ? "Reusing the dependency environment already prepared for the same manifests and runtime." : "The identical setup attempt already failed; continuing to adversarial execution without repeating it." };
        results.push(result);
        if (result.dependencyRoot) (context.review.dependencyRoots ??= {})[revision] = result.dependencyRoot;
        continue;
      }
      context.options.onEvent?.({ task: "preflight", stage: "preflight", kind: "progress", message: `preflight: preparing missing dependencies for ${revision} in a private setup copy` });
      const source = path.join(directory, "source");
      const scratch = path.join(directory, "scratch");
      await cloneDirectory(snapshot.directory, source);
      await mkdir(scratch, { recursive: true });
      const userConfig = path.join(directory, "npm-user.rc");
      const globalConfig = path.join(directory, "npm-global.rc");
      await writeFile(userConfig, "");
      await writeFile(globalConfig, "");
      const argv = [lock ? "ci" : "install", "--no-audit", "--no-fund"];
      const processResult = await runProcess("npm", argv, {
        cwd: source, timeoutMs: context.options.dependencySetupTimeoutMs ?? 300000, signal: context.options.signal,
        env: { ...minimalEnvironment(), PATH: `${path.dirname(node.executable)}${path.delimiter}${minimalEnvironment().PATH}`, TMPDIR: scratch,
          npm_config_cache: path.join(directory, "cache"), npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig, npm_config_update_notifier: "false" },
      });
      await writeFile(path.join(directory, "stdout.log"), processResult.stdout);
      await writeFile(path.join(directory, "stderr.log"), processResult.stderr);
      await writeFile(path.join(directory, "invocation.json"), JSON.stringify({ executable: "npm", argv, cwd: source, node }));
      const complete = successful(processResult);
      result = { ...result, status: complete ? "completed" : "incomplete", dependencyRoot: complete ? source : null,
        reason: complete ? "Package-manager installation completed in a private copy; dependencies are checked again before probes." : `Dependency installation failed (exit ${processResult.exitCode}, timed out: ${processResult.timedOut}); adversarial testing will still be attempted.`, result: processResult };
      prepared.set(key, result);
      if (complete) (context.review.dependencyRoots ??= {})[revision] = source;
    } catch (error) { result.reason = errorMessage(error); }
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "setup.json"), JSON.stringify(result, null, 2));
    results.push(result);
    context.options.onEvent?.({ task: "preflight", stage: "preflight", kind: "progress", message: `preflight: setup ${revision} ${result.status}: ${result.reason}` });
  }
  return results;
}
