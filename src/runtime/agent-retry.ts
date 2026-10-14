import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { errorMessage } from "../shared/errors.ts";
import { validatePayload } from "../shared/schema.ts";
import type { AgentBridge, AgentRequest } from "../shared/types.ts";

export interface AgentRetryOptions {
  retries: number;
  delayMs: number;
  label: string;
  /** Integrity checks run around each attempt; their failures are never retried. */
  verifyAttempt?: () => Promise<void>;
}

interface AttemptRecord {
  attempt: number;
  artifacts: string;
  durationMs: number;
  status: "completed" | "failed";
  error?: string;
}

async function saveAttempts(directory: string, attempts: AttemptRecord[]): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "attempts.json"), `${JSON.stringify({ attempts }, null, 2)}\n`);
}

/** Retry bounded model/CLI failures while preserving every attempt for diagnosis. */
export async function runAgentWithRetries<T>(bridge: AgentBridge, request: AgentRequest, options: AgentRetryOptions): Promise<T> {
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 3) throw new Error("Agent retries must be between 0 and 3");
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 30000) throw new Error("Agent retry delay must be between 0 and 30000 milliseconds");
  const attempts: AttemptRecord[] = [];
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    request.signal?.throwIfAborted();
    await options.verifyAttempt?.();
    const artifacts = attempt === 0 ? request.artifacts : path.join(request.artifacts, "retries", `attempt-${attempt + 1}`);
    const started = performance.now();
    let payload: T | undefined;
    let failure: unknown;
    try {
      const value = await bridge.run({ ...request, artifacts });
      payload = validatePayload<T>(request.schema, value, options.label);
    } catch (error) { failure = error; }
    try { await options.verifyAttempt?.(); }
    catch (integrityError) {
      attempts.push({ attempt: attempt + 1, artifacts, durationMs: Math.round(performance.now() - started),
        status: "failed", error: errorMessage(integrityError).slice(0, 4000) });
      await saveAttempts(request.artifacts, attempts);
      throw integrityError;
    }
    if (failure === undefined) {
      attempts.push({ attempt: attempt + 1, artifacts, durationMs: Math.round(performance.now() - started), status: "completed" });
      await saveAttempts(request.artifacts, attempts);
      return payload as T;
    } else {
      attempts.push({ attempt: attempt + 1, artifacts, durationMs: Math.round(performance.now() - started),
        status: "failed", error: errorMessage(failure).slice(0, 4000) });
      await saveAttempts(request.artifacts, attempts);
      if (request.signal?.aborted || attempt === options.retries) throw failure;
      const waitMs = Math.min(options.delayMs * 2 ** attempt, 30000);
      const reason = errorMessage(failure).replace(/\s+/g, " ").slice(0, 500);
      request.onEvent?.({ task: request.task, stage: request.stage, kind: "progress",
        message: `${request.task} / ${bridge.name}: retrying ${request.stage} (attempt ${attempt + 2}/${options.retries + 1}) after ${reason}` });
      if (waitMs) await delay(waitMs, undefined, { signal: request.signal });
    }
  }
  throw new Error(`${options.label} exhausted its retry budget`);
}
