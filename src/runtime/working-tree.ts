import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSnapshotUnchanged, excludedReason, exportSnapshot, hashDirectory, readGit, resolveCommit, safeRelativePath } from "./repository.ts";
import { cloneDirectory, referenceDirectory } from "./source.ts";
import type { Snapshot, WorkingTreeCapture } from "../shared/types.ts";

const maxBytes = 32 * 1024 * 1024;

/** Never follow a source symlink, including a symlink in a parent directory. */
async function sourceInfo(repo: string, file: string) {
  let current = repo;
  const parts = file.split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!info) return null;
    if (info.isSymbolicLink()) return { excluded: "symlink or symlink parent" } as const;
    if (index < parts.length - 1 && !info.isDirectory()) return null;
    if (index === parts.length - 1) return info.isFile() ? { info } : { excluded: "directory, submodule, or special file" };
  }
  return null;
}

export async function copySnapshot(snapshot: Snapshot, directory: string): Promise<Snapshot> {
  await assertSnapshotUnchanged(snapshot);
  await cloneDirectory(snapshot.directory, directory);
  const copy = { ...snapshot, directory };
  await assertSnapshotUnchanged(copy);
  return copy;
}

/** Freeze effective on-disk changes against HEAD without touching the index or making commits. */
export async function captureWorkingTree(repo: string, directory: string): Promise<WorkingTreeCapture> {
  const commit = await resolveCommit(repo, "HEAD");
  const base = await exportSnapshot(repo, commit, path.join(directory, "base"));
  const entries = (await readGit(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "--exclude=reports/**", "-z"]))
    .toString("utf8").split("\0").filter(Boolean);
  const candidates = [...new Set([...base.files, ...base.excluded.map(entry => entry.path), ...entries])].sort();
  if (candidates.length > 5000) throw new Error("Working tree exceeds the 5000-file review limit");
  const headDirectory = path.join(directory, "head");
  await mkdir(headDirectory, { recursive: true });
  const files: string[] = [];
  const excluded: Snapshot["excluded"] = [];
  const changed = new Set<string>();
  let total = 0;
  for (const file of candidates) {
    safeRelativePath(file);
    const reason = excludedReason(file);
    if (reason) {
      excluded.push({ path: file, reason });
      if (!base.excluded.some(entry => entry.path === file)) changed.add(file);
      continue;
    }
    const source = await sourceInfo(repo, file);
    if (!source || "excluded" in source) {
      if (source) excluded.push({ path: file, reason: source.excluded! });
      if (base.files.includes(file) || source && !base.excluded.some(entry => entry.path === file)) changed.add(file);
      continue;
    }
    total += source.info.size;
    if (total > maxBytes) throw new Error("Working-tree snapshot exceeds the 32 MiB limit");
    const handle = await open(path.join(repo, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== source.info.dev || before.ino !== source.info.ino || before.size !== source.info.size || before.mode !== source.info.mode) throw new Error(`Source changed while capturing ${file}; retry the review.`);
      // One extra byte detects growth while keeping allocation bounded by the checked size.
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      bytes = buffer.subarray(0, length);
      const after = await handle.stat();
      const current = await sourceInfo(repo, file);
      if (bytes.length !== source.info.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !current || "excluded" in current || current.info.dev !== before.dev || current.info.ino !== before.ino) throw new Error(`Source changed while capturing ${file}; retry the review.`);
    } finally { await handle.close(); }
    const mode = source.info.mode & 0o111 ? 0o755 : 0o644;
    const destination = path.join(headDirectory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    files.push(file);
    let unchanged = false;
    if (!base.files.includes(file)) changed.add(file);
    else {
      const baselinePath = path.join(base.directory, file);
      const baseline = await readFile(baselinePath);
      const baselineMode = (await stat(baselinePath)).mode & 0o111 ? 0o755 : 0o644;
      unchanged = baseline.equals(bytes) && baselineMode === mode;
      if (!unchanged) changed.add(file);
    }
    if (unchanged) await copyFile(path.join(base.directory, file), destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    else await writeFile(destination, bytes, { mode, flag: "wx" });
  }
  if (await resolveCommit(repo, "HEAD") !== commit) throw new Error("HEAD changed while capturing the working tree; retry the review.");
  const sha256 = await hashDirectory(headDirectory);
  if (sha256 === base.sha256) {
    await rm(headDirectory, { recursive: true });
    await referenceDirectory(base.directory, headDirectory);
  }
  return { base, head: { commit: `working-tree:${sha256}`, directory: headDirectory, files, excluded, sha256 }, changedFiles: [...changed].sort() };
}

/** Diff only exported bytes, including additions/deletions; no filters, hooks, or live source reads. */
export async function diffSnapshots(base: Snapshot, head: Snapshot, files: string[]): Promise<{ text: string; truncated: boolean }> {
  let text = "";
  const limit = 250000;
  for (const file of files) {
    const before = base.files.includes(file) ? path.join(base.directory, file) : "/dev/null";
    const after = head.files.includes(file) ? path.join(head.directory, file) : "/dev/null";
    if (before === after) continue;
    const data = await readGit(path.dirname(base.directory), ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=15", "--", before, after], undefined, [1]);
    text += data.toString("utf8");
    if (Buffer.byteLength(text) > limit) return { text: Buffer.from(text).subarray(0, limit).toString("utf8"), truncated: true };
  }
  return { text: text || "No exported source changes in scope.", truncated: false };
}
