import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { minimalEnvironment } from "./process.ts";
import type { Snapshot } from "../shared/types.ts";

const maxSnapshotBytes = 32 * 1024 * 1024;

async function git(repo: string, args: string[], stdin?: string, allowedExits: number[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args], {
      encoding: "buffer", maxBuffer: maxSnapshotBytes + 4 * 1024 * 1024, timeout: 30000,
      env: { ...minimalEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => error && !allowedExits.includes(Number(error.code)) ? reject(new Error(`Git ${args[0]} failed: ${error.message}`)) : resolve(stdout));
    child.stdin?.end(stdin);
  });
}

export { git as readGit, excludedReason };


export function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) || value.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function resolveRepository(repo: string): Promise<string> {
  return (await git(path.resolve(repo), ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim();
}

export async function changedFiles(repo: string, base: string, head: string, focus: string[]): Promise<string[]> {
  const all = (await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, head, "--"]))
    .toString("utf8").split("\0").filter(Boolean);
  focus.forEach(safeRelativePath);
  return all.filter(file => !focus.length || focus.some(scope => file === scope || file.startsWith(`${scope}/`)));
}

export async function diff(repo: string, base: string, head: string, files: string[]): Promise<{ text: string; truncated: boolean }> {
  if (!files.length) return { text: "No changed files in scope.", truncated: false };
  const data = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=15", base, head, "--", ...files]);
  const limit = 250000;
  return { text: data.subarray(0, limit).toString("utf8"), truncated: data.length > limit };
}

function excludedReason(file: string): string | null {
  const parts = file.split("/");
  if (parts.some(p => [".git", ".agents", ".codex", ".cosine", ".aws", ".ssh", "node_modules"].includes(p))) return "agent configuration, credentials, or installed dependencies";
  if (parts.some(p => p === "AGENTS.md" || p === ".npmrc" || p === ".netrc" || p === "auth.json" || p.startsWith(".env"))) return "instruction or potential secret file";
  if (/\.(pem|key|p12|pfx)$/i.test(file)) return "potential private key";
  return null;
}

/** Export blobs directly: no checkout hooks, symlink extraction, or untracked files. */
export async function exportSnapshot(repo: string, commit: string, directory: string): Promise<Snapshot> {
  const rows = (await git(repo, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit])).toString("utf8").split("\0").filter(Boolean);
  const excluded: Snapshot["excluded"] = [];
  const entries: { file: string; sha: string; bytes: number; executable: boolean }[] = [];
  let totalBytes = 0;
  for (const row of rows) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+([\d-]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("Unexpected Git tree entry");
    const mode = match[1]!;
    const type = match[2]!;
    const sha = match[3]!;
    const size = match[4]!;
    const file = match[5]!;
    let reason: string | null = null;
    try { safeRelativePath(file); } catch { reason = "unsafe path"; }
    reason ??= mode === "120000" || type !== "blob" ? "symlink or submodule" : excludedReason(file);
    if (reason) { excluded.push({ path: file, reason }); continue; }
    const bytes = Number(size);
    totalBytes += bytes;
    if (totalBytes > maxSnapshotBytes || entries.length >= 5000) throw new Error("Repository snapshot exceeds the 32 MiB / 5000-file limit");
    entries.push({ file, sha, bytes, executable: mode === "100755" });
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  if (entries.length) {
    const blobs = await git(repo, ["cat-file", "--batch"], entries.map(e => e.sha).join("\n") + "\n");
    let offset = 0;
    for (const entry of entries) {
      const end = blobs.indexOf(10, offset);
      if (end < 0 || blobs.subarray(offset, end).toString("utf8") !== `${entry.sha} blob ${entry.bytes}`) throw new Error("Invalid Git blob batch response");
      const content = blobs.subarray(end + 1, end + 1 + entry.bytes);
      if (content.length !== entry.bytes) throw new Error("Incomplete Git blob response");
      const destination = path.join(directory, entry.file);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, content, { mode: entry.executable ? 0o755 : 0o644, flag: "wx" });
      offset = end + 1 + entry.bytes + 1;
    }
  }
  return { commit, directory, files: entries.map(e => e.file), excluded, sha256: await hashDirectory(directory) };
}

export async function hashDirectory(directory: string, onFile?: (file: string) => void): Promise<string> {
  const hash = createHash("sha256");
  async function visit(folder: string, prefix: string): Promise<void> {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(full, file);
      else if (entry.isFile()) {
        onFile?.(file);
        const bytes = await readFile(full);
        const mode = (await stat(full)).mode & 0o777;
        hash.update(file + "\0" + mode + "\0" + bytes.length + "\0"); hash.update(bytes);
      } else throw new Error(`Unexpected symlink or special file: ${file}`);
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}

export async function assertSnapshotUnchanged(snapshot: Snapshot): Promise<void> {
  const files: string[] = [];
  if (await hashDirectory(snapshot.directory, file => files.push(file)) !== snapshot.sha256) {
    const expected = new Set(snapshot.files);
    const actual = new Set(files);
    const added = files.filter(file => !expected.has(file)).slice(0, 10);
    const removed = snapshot.files.filter(file => !actual.has(file)).slice(0, 10);
    throw new Error(`The ${snapshot.commit} source snapshot was modified; results rejected${added.length ? `; added paths: ${added.join(", ")}` : ""}${removed.length ? `; removed paths: ${removed.join(", ")}` : ""}`);
  }
}
