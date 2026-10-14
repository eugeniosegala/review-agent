import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BillingProvider } from "../../bridge.ts";

export interface CosineBillingRoute {
  provider: BillingProvider | "custom" | "unknown";
  description: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

/** Inspect only non-secret Cosine routing fields. Credential contents are never read. */
export async function inspectCosineBilling(home = process.env.HOME ?? os.homedir()): Promise<CosineBillingRoute> {
  const directory = path.join(home, ".cosine");
  let content: string;
  try { content = await readFile(path.join(directory, "config.toml"), "utf8"); }
  catch { return { provider: "unknown", description: "unknown (Cosine config was not found)" }; }

  let section = "";
  let authMethod = "";
  let loggedInWithOpenAI = false;
  let inferenceBaseUrl = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) { section = sectionMatch[1]!; continue; }
    const setting = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
    if (!setting) continue;
    const key = setting[1]!;
    const value = unquote(setting[2]!);
    if (section === "auth.openai" && key === "auth_method") authMethod = value;
    if (section === "config" && key === "logged_in_with_openai") loggedInWithOpenAI = value === "true";
    if (section === "inference" && key === "base_url") inferenceBaseUrl = value;
  }

  let oauthFilePresent = false;
  try { await access(path.join(directory, "auth.openai.json")); oauthFilePresent = true; } catch { /* absent */ }
  if (authMethod === "oauth" && loggedInWithOpenAI && oauthFilePresent) {
    return { provider: "openai", description: "OpenAI account through Cosine OAuth" };
  }
  try {
    const hostname = new URL(inferenceBaseUrl).hostname.toLowerCase();
    if (hostname === "api.openai.com") return { provider: "openai", description: "OpenAI API account" };
    if (hostname === "api.cosine.sh" || hostname.endsWith(".cosine.sh")) return { provider: "cosine", description: "Cosine managed inference (Cosine credits)" };
    if (hostname) return { provider: "custom", description: `custom inference endpoint (${hostname})` };
  } catch { /* missing or invalid URL */ }
  return { provider: "unknown", description: "unknown" };
}

export async function verifyCosineBilling(expected: BillingProvider, home?: string): Promise<CosineBillingRoute> {
  const route = await inspectCosineBilling(home);
  if (route.provider !== expected) {
    const setup = expected === "openai"
      ? "Run 'cos login-with-chatgpt' for OpenAI OAuth, or configure Cosine's OpenAI API endpoint and key."
      : "Sign in to Cosine or set billingProvider to match the intended account.";
    throw new Error(`Cosine billing route mismatch: review-agent expects ${expected} billing, but detected ${route.description}. ${setup}`);
  }
  return route;
}
