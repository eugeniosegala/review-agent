import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashDirectory, safeRelativePath } from "./repository.ts";
import { minimalEnvironment, runProcess } from "./process.ts";
import { observationSchema } from "./observation.ts";
import { validatePayload } from "../shared/schema.ts";
import { nodeToolchain } from "./node-toolchain.ts";
import type { ExecutionEvidence, Experiment, ExperimentExecutor, ExperimentRequest, Observation, ProcessResult } from "../shared/types.ts";

export const observationPrefix = "REVIEW_AGENT_OBSERVATION:";

export function readObservation(result: ProcessResult): Observation | null {
  const lines = result.stdout.split("\n").filter(line => line.startsWith(observationPrefix));
  if (lines.length !== 1) return null;
  try { return validatePayload<Observation>(observationSchema, JSON.parse(lines[0]!.slice(observationPrefix.length)), "Observation"); }
  catch { return null; }
}

export function executionOutcome(result: ProcessResult, observation: Observation | null): ExecutionEvidence["outcome"] {
  if (result.timedOut || result.aborted || result.outputLimited || result.signal || !observation) return "error";
  if (observation.status === "pass" && result.exitCode === 0) return "pass";
  if (observation.status === "violation" && result.exitCode === 1) return "violation";
  return "error";
}

export async function writeExperiment(experiment: Experiment, directory: string): Promise<string> {
  const seen = new Set<string>();
  let total = 0;
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const file of experiment.files) {
    safeRelativePath(file.path);
    if (seen.has(file.path) || file.path.split("/").some(p => [".git", ".agents", ".codex"].includes(p))) throw new Error(`Invalid experiment path: ${file.path}`);
    seen.add(file.path);
    total += Buffer.byteLength(file.content);
    if (total > 250000) throw new Error("Experiment payload exceeds 250 KB");
    const destination = path.join(directory, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, file.content, { flag: "wx", mode: 0o644 });
  }
  return hashDirectory(directory);
}

function expandArgs(argv: string[], repo: string, payload: string): string[] {
  return argv.map(arg => arg.replaceAll("{{repo}}", repo).replaceAll("{{experiments}}", payload));
}

async function evidence(request: ExperimentRequest, result: ProcessResult, executor: string, resolvedArgv: string[], payloadSha256: string): Promise<ExecutionEvidence> {
  await mkdir(request.artifacts, { recursive: true });
  const stdoutPath = path.join(request.artifacts, "stdout.log");
  const stderrPath = path.join(request.artifacts, "stderr.log");
  await writeFile(stdoutPath, result.stdout);
  await writeFile(stderrPath, result.stderr);
  const observation = readObservation(result);
  const record: ExecutionEvidence = {
    id: `${request.experiment.id}:${request.revision}`, experimentId: request.experiment.id,
    hypothesisId: request.experiment.hypothesisId, revision: request.revision, commit: request.snapshot.commit,
    argv: request.experiment.argv, resolvedArgv, payloadSha256, executor,
    runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch }, result, observation,
    outcome: executionOutcome(result, observation), stdoutPath, stderrPath,
  };
  await writeFile(path.join(request.artifacts, "execution.json"), JSON.stringify(record, null, 2));
  return record;
}

/** The deployment environment is the security boundary; this owns process isolation. */
export class RuntimeExecutor implements ExperimentExecutor {
  readonly name = "current-runtime";
  readonly context = { nodeVersion: process.version, platform: process.platform, architecture: process.arch };

  async execute(request: ExperimentRequest): Promise<ExecutionEvidence> {
    const payloadSha256 = await hashDirectory(request.payloadDirectory);
    const argv = expandArgs(request.experiment.argv, request.snapshot.directory, request.payloadDirectory);
    const toolchain = await nodeToolchain(request.snapshot.directory);
    if (argv[0] === "node") argv[0] = toolchain.executable;
    const scratch = path.join(request.artifacts, "scratch");
    await mkdir(scratch, { recursive: true });
    const result = await runProcess(argv[0]!, argv.slice(1), {
      cwd: request.snapshot.directory, timeoutMs: request.timeoutMs, signal: request.signal,
      env: { ...minimalEnvironment(), PATH: `${path.dirname(toolchain.executable)}${path.delimiter}${minimalEnvironment().PATH}`, REVIEW_REPO: request.snapshot.directory,
        REVIEW_EXPERIMENTS: request.payloadDirectory, REVIEW_SCRATCH: scratch, TMPDIR: scratch },
    });
    if (await hashDirectory(request.payloadDirectory) !== payloadSha256) throw new Error("Experiment payload changed during execution");
    const record = await evidence(request, result, this.name, argv, payloadSha256);
    record.runtime.nodeVersion = `v${toolchain.version}`;
    await writeFile(path.join(request.artifacts, "execution.json"), JSON.stringify(record, null, 2));
    return record;
  }
}
