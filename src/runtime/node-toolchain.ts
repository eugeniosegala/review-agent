import { access, readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { minimalEnvironment, runProcess } from "./process.ts";

export interface NodeToolchain { executable: string; version: string; requested: string | null; reason: string }
const selections = new Map<string, Promise<NodeToolchain>>();

/** Select an installed application runtime without changing the runner or installing tools. */
export async function nodeToolchain(directory: string, options: { path?: string; executable?: string; voltaHome?: string } = {}): Promise<NodeToolchain> {
  const executable = options.executable ?? process.execPath;
  const searchPath = options.path ?? process.env.PATH ?? "";
  let pin: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    pin = semver.valid(manifest.volta?.node) ?? null;
  } catch { /* Non-Node source uses the runner only as a probe launcher. */ }
  const roots = new Set<string>();
  if (options.voltaHome ?? process.env.VOLTA_HOME) roots.add(options.voltaHome ?? process.env.VOLTA_HOME!);
  for (const entry of searchPath.split(path.delimiter)) {
    if (path.basename(entry) === "bin" && path.basename(path.dirname(entry)) === ".volta") roots.add(path.dirname(entry));
  }
  const key = JSON.stringify([pin, executable, [...roots]]);
  if (!selections.has(key)) selections.set(key, (async () => {
    const candidates = pin ? [...roots].map(root => path.join(root, "tools", "image", "node", pin!, "bin", process.platform === "win32" ? "node.exe" : "node")) : [];
    candidates.push(executable);
    for (const candidate of candidates) {
      try {
        await access(candidate);
        // The running process already proves its own executable and version. Reuse
        // that fact instead of launching another Node process for every selection.
        const result = candidate === process.execPath ? { exitCode: 0, stdout: process.version }
          : await runProcess(candidate, ["--version"], { timeoutMs: 3000, env: minimalEnvironment() });
        const version = semver.valid(result.stdout.trim());
        if (result.exitCode !== 0 || !version) continue;
        if (candidate !== executable && version !== pin) continue;
        return { executable: candidate, version, requested: pin,
          reason: pin && version === pin ? "Using the installed application Volta pin." : pin ? "The pin is unavailable; verify compatibility of the available runtime." : "No exact application runtime pin; verify declared compatibility." };
      } catch { /* Try the existing runner runtime next. */ }
    }
    throw new Error("No usable Node executable was found for launching checks.");
  })());
  const selection = selections.get(key)!;
  try { return await selection; }
  catch (error) {
    if (selections.get(key) === selection) selections.delete(key);
    throw error;
  }
}
