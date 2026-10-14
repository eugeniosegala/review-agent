import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessResult } from "../shared/types.ts";

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
}

/** No shell interpolation; stop the entire process group on timeout/cancellation. */
export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  const maxBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("Operation cancelled"));
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env, shell: false,
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may already have exited. */ }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
      killTimer.unref();
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - bytes);
      const kept = chunk.subarray(0, remaining);
      chunks[stream].push(kept);
      bytes += chunk.length;
      if (stream === "stdout") options.onStdout?.(kept.toString("utf8"));
      if (bytes > maxBytes) { outputLimited = true; stop(); }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.stdin.on("error", () => { /* EPIPE after an early process exit. */ });
    child.stdin.end(options.stdin);
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const abort = () => { aborted = true; stop(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const clean = () => {
      clearTimeout(timer);
      // Successful readiness checks can also leave background servers behind.
      if (process.platform !== "win32" || timedOut || aborted || outputLimited) kill("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => { clean(); reject(error); });
    child.on("close", (exitCode, signal) => {
      clean();
      resolve({ exitCode, signal, timedOut, aborted, outputLimited,
        durationMs: Math.round(performance.now() - started),
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });
  });
}

export function successful(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputLimited;
}

/** Experiments inherit no host credentials, runtime hooks, or arbitrary environment. */
export function minimalEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" };
}
