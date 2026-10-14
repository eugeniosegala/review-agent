import type { BridgeOptions } from "../bridges/bridge.ts";
import { integerSchema, limits } from "../shared/limits.ts";
import type { JsonSchema } from "../shared/types.ts";

export interface SharedReviewSettings {
  /** Maximum parallel work items inside each task; top-level tasks overlap independently. */
  perTaskConcurrency: number;
  agentTimeoutSeconds: number;
  agentRetries: number;
  agentRetryDelaySeconds: number;
}

export interface PreflightSettings {
  installDependencies: boolean;
  dependencySetupTimeoutSeconds: number;
}

export interface CodeQualitySettings {
  enabled: boolean;
  maxFindingsPerBatch: number;
  maxBatches: number;
}

export interface AdversarialSettings {
  enabled: boolean;
  maxHypotheses: number;
  maxInvestigationBatches: number;
  maxExperimentsPerHypothesis: number;
  probeTimeoutSeconds: number;
  assessmentConcurrency: number;
  assessmentRetries: number;
  probeRepairAttempts: number;
  assessmentTimeoutSeconds: number;
}

export interface TaskSettings {
  preflight: PreflightSettings;
  codeQuality: CodeQualitySettings;
  adversarial: AdversarialSettings;
}

export interface ReviewSettings extends SharedReviewSettings {
  tasks: TaskSettings;
}

export interface AgentSettings extends BridgeOptions, SharedReviewSettings {
  cli: string;
  bridgeModules: string[];
}

export interface AgentConfig extends AgentSettings {
  tasks: TaskSettings;
}

export type AgentConfigInput = Partial<AgentSettings> & {
  tasks?: {
    preflight?: Partial<PreflightSettings>;
    codeQuality?: Partial<CodeQualitySettings>;
    adversarial?: Partial<AdversarialSettings>;
  };
};

export const defaultReviewSettings: ReviewSettings = {
  perTaskConcurrency: 3,
  agentTimeoutSeconds: 300,
  agentRetries: 1,
  agentRetryDelaySeconds: 2,
  tasks: {
    preflight: { installDependencies: true, dependencySetupTimeoutSeconds: 300 },
    codeQuality: { enabled: true, maxFindingsPerBatch: 10, maxBatches: 64 },
    adversarial: {
      enabled: true,
      maxHypotheses: 6,
      maxInvestigationBatches: 64,
      maxExperimentsPerHypothesis: 1,
      probeTimeoutSeconds: 120,
      assessmentConcurrency: 2,
      assessmentRetries: 1,
      probeRepairAttempts: 1,
      assessmentTimeoutSeconds: 300,
    },
  },
};

export function extractReviewSettings(config: AgentConfig): ReviewSettings {
  return {
    perTaskConcurrency: config.perTaskConcurrency,
    agentTimeoutSeconds: config.agentTimeoutSeconds,
    agentRetries: config.agentRetries,
    agentRetryDelaySeconds: config.agentRetryDelaySeconds,
    tasks: config.tasks,
  };
}

const value = { type: "string", minLength: 1, maxLength: 1024, pattern: "^[^\\u0000\\r\\n]+$" };

/** Config files are partial overrides; unknown keys fail so typos cannot silently change a run. */
export const configSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    cli: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    executable: value, model: value,
    speed: { type: "string", enum: ["standard", "fast"] },
    reasoningEffort: { type: "string", enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
    verbosity: { type: "string", enum: ["low", "medium", "high"] },
    billingProvider: { type: "string", enum: ["cosine", "openai"] },
    structuredOutput: { type: "string", enum: ["auto", "native", "prompt"] },
    bridgeModules: { type: "array", items: value, maxItems: 10 },
    perTaskConcurrency: integerSchema(limits.perTaskConcurrency),
    agentTimeoutSeconds: integerSchema(limits.timeoutSeconds),
    agentRetries: integerSchema(limits.agentRetries),
    agentRetryDelaySeconds: integerSchema(limits.retryDelaySeconds),
    tasks: {
      type: "object", additionalProperties: false,
      properties: {
        preflight: {
          type: "object", additionalProperties: false,
          properties: {
            installDependencies: { type: "boolean" },
            dependencySetupTimeoutSeconds: integerSchema(limits.timeoutSeconds),
          },
        },
        codeQuality: {
          type: "object", additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            maxFindingsPerBatch: integerSchema(limits.qualityFindings),
            maxBatches: integerSchema(limits.sourceBatches),
          },
        },
        adversarial: {
          type: "object", additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            maxHypotheses: integerSchema(limits.hypotheses),
            maxInvestigationBatches: integerSchema(limits.sourceBatches),
            maxExperimentsPerHypothesis: integerSchema(limits.experimentsPerHypothesis),
            probeTimeoutSeconds: integerSchema(limits.timeoutSeconds),
            assessmentConcurrency: integerSchema(limits.assessmentConcurrency),
            assessmentRetries: integerSchema(limits.assessmentRetries),
            probeRepairAttempts: integerSchema(limits.assessmentRetries),
            assessmentTimeoutSeconds: integerSchema(limits.timeoutSeconds),
          },
        },
      },
    },
  },
};
