import type { JsonSchema } from "./types.ts";

export interface IntegerLimit {
  minimum: number;
  maximum: number;
}

export const limits = {
  perTaskConcurrency: { minimum: 1, maximum: 32 },
  hypotheses: { minimum: 1, maximum: 20 },
  experimentsPerHypothesis: { minimum: 1, maximum: 3 },
  qualityFindings: { minimum: 1, maximum: 20 },
  sourceBatches: { minimum: 1, maximum: 256 },
  assessmentConcurrency: { minimum: 1, maximum: 8 },
  assessmentRetries: { minimum: 0, maximum: 3 },
  agentRetries: { minimum: 0, maximum: 3 },
  retryDelaySeconds: { minimum: 0, maximum: 30 },
  timeoutSeconds: { minimum: 1, maximum: 3600 },
} as const satisfies Record<string, IntegerLimit>;

export function integerSchema(limit: IntegerLimit): JsonSchema {
  if (!limit || !Number.isInteger(limit.minimum) || !Number.isInteger(limit.maximum)) {
    throw new Error("Internal configuration error: missing or invalid integer limit");
  }
  return { type: "integer", minimum: limit.minimum, maximum: limit.maximum };
}

export function assertInteger(value: number, label: string, limit: IntegerLimit): void {
  if (!Number.isInteger(value) || value < limit.minimum || value > limit.maximum) {
    throw new Error(`${label} must be between ${limit.minimum} and ${limit.maximum}`);
  }
}

export function assertMilliseconds(value: number, label: string): void {
  const minimum = limits.timeoutSeconds.minimum * 1000;
  const maximum = limits.timeoutSeconds.maximum * 1000;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${limits.timeoutSeconds.minimum} and ${limits.timeoutSeconds.maximum} seconds`);
  }
}
