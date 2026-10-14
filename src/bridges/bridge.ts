import type { AgentBridge } from "../shared/types.ts";

export type Speed = "standard" | "fast";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type BillingProvider = "cosine" | "openai";
export type StructuredOutputMode = "auto" | "native" | "prompt";
export interface BridgeOptions {
  executable?: string;
  model?: string;
  speed?: Speed;
  reasoningEffort?: ReasoningEffort;
  verbosity?: "low" | "medium" | "high";
  /** Expected account charged by bridges that can route through multiple providers. */
  billingProvider?: BillingProvider;
  /** How a CLI receives the JSON schema. Auto selects a model-compatible transport. */
  structuredOutput?: StructuredOutputMode;
}
export type BridgeFactory = (options: BridgeOptions) => AgentBridge;

export class BridgeRegistry {
  private factories = new Map<string, BridgeFactory>();

  register(name: string, factory: BridgeFactory): this {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || this.factories.has(name)) throw new Error(`Invalid or duplicate bridge: ${name}`);
    this.factories.set(name, factory);
    return this;
  }

  create(name: string, options: BridgeOptions = {}): AgentBridge {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown bridge '${name}'. Available: ${this.names().join(", ")}`);
    return factory(options);
  }

  names(): string[] { return [...this.factories.keys()]; }
}
