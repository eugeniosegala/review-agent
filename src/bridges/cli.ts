import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, successful } from "../runtime/process.ts";
import { errorMessage } from "../shared/errors.ts";
import { validatePayload } from "../shared/schema.ts";
import type { AgentBridge, AgentRequest, ProcessResult } from "../shared/types.ts";

/** The bridge translates application tasks into a provider's command protocol. */
export interface CliInvocation {
  executable: string;
  args: string[];
  stdin?: string;
  resultFile?: string;
  env?: NodeJS.ProcessEnv;
  files?: { path: string; content: string }[];
  auditArgs?: string[];
}

export abstract class CliBridge implements AgentBridge {
  abstract readonly name: string;
  protected abstract translate(request: AgentRequest, schemaFile: string, resultFile: string, promptFile: string): CliInvocation;
  protected normalizeOutput(output: string): unknown { return JSON.parse(output); }
  protected validateEvents(_result: ProcessResult): void {}

  async run(request: AgentRequest): Promise<unknown> {
    await mkdir(request.artifacts, { recursive: true });
    const schemaFile = path.join(request.artifacts, "schema.json");
    const resultFile = path.join(request.artifacts, "response.json");
    const promptFile = path.join(request.artifacts, "prompt.md");
    await writeFile(schemaFile, JSON.stringify(request.schema, null, 2));
    await writeFile(promptFile, request.prompt);
    const command = this.translate(request, schemaFile, resultFile, promptFile);
    await rm(resultFile, { force: true });
    if (command.resultFile && path.resolve(command.resultFile) !== path.resolve(resultFile)) await rm(command.resultFile, { force: true });
    for (const file of command.files ?? []) {
      const destination = path.resolve(file.path);
      const artifacts = path.resolve(request.artifacts);
      if (destination !== artifacts && !destination.startsWith(`${artifacts}${path.sep}`)) throw new Error(`${this.name} bridge auxiliary file escapes its artifact directory`);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    request.onEvent?.({ task: request.task, kind: "started", stage: request.stage, message: `${request.task} / ${this.name}: ${request.stage}` });
    // Record argument structure, never environment variables or credentials.
    await writeFile(path.join(request.artifacts, "invocation.json"), JSON.stringify({ executable: command.executable, args: command.auditArgs ?? command.args }, null, 2));
    let result: ProcessResult;
    try {
      result = await runProcess(command.executable, command.args, {
        cwd: request.workspace, env: command.env, stdin: command.stdin,
        timeoutMs: request.timeoutMs, maxOutputBytes: 8 * 1024 * 1024, signal: request.signal,
      });
    } catch (error) {
      throw new Error(`${this.name} bridge could not start: ${errorMessage(error)}`);
    }
    await writeFile(path.join(request.artifacts, "events.log"), result.stdout);
    await writeFile(path.join(request.artifacts, "stderr.log"), result.stderr);
    await writeFile(path.join(request.artifacts, "process.json"), JSON.stringify({ ...result, stdout: undefined, stderr: undefined }, null, 2));
    if (!successful(result)) {
      const reason = result.timedOut ? "timed out" : result.aborted ? "cancelled" : result.outputLimited ? "output limit exceeded" : `exit ${result.exitCode}`;
      throw new Error(`${this.name} ${request.stage} failed (${reason}); see ${request.artifacts}`);
    }
    this.validateEvents(result);
    try {
      if (command.resultFile) {
        const info = await lstat(command.resultFile);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Response must be a regular file smaller than 2 MiB");
      }
      const raw = command.resultFile ? await readFile(command.resultFile, "utf8") : result.stdout;
      const payload = validatePayload(request.schema, this.normalizeOutput(raw), `${this.name} structured response`);
      if (!command.resultFile) await writeFile(resultFile, JSON.stringify(payload, null, 2));
      request.onEvent?.({ task: request.task, kind: "completed", stage: request.stage, message: `${request.task} / ${this.name}: ${request.stage} completed` });
      return payload;
    } catch (error) {
      throw new Error(`${this.name} returned no valid JSON response: ${errorMessage(error)}`);
    }
  }
}
