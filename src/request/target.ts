import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRepository, safeRelativePath } from "../runtime/repository.ts";

async function existingGitTarget(candidate: string): Promise<boolean> {
  try {
    const resolved = await realpath(path.resolve(candidate));
    const info = await stat(resolved);
    if (!info.isDirectory() && !info.isFile()) return false;
    await resolveRepository(info.isDirectory() ? resolved : path.dirname(resolved));
    return true;
  } catch { return false; }
}

/** Recover a shell-split path from filesystem evidence while rejecting ambiguous targets. */
export async function resolveTargetArguments(args: string[]): Promise<string[]> {
  const first = args[0];
  if (!first) return args;
  const firstValid = await existingGitTarget(first);
  if (firstValid && /\s/.test(first)) return args;
  // Prefer the longest existing Git target and leave all subsequent words as the description.
  for (let count = Math.min(args.length, 64); count >= 2; count--) {
    const candidate = args.slice(0, count).join(" ");
    if (await existingGitTarget(candidate)) {
      if (firstValid) throw new Error(`Ambiguous review path: both ${JSON.stringify(first)} and ${JSON.stringify(candidate)} are valid. Quote the full intended path, or pass just the path and enter the review description when prompted.`);
      return [candidate, ...args.slice(count)];
    }
  }
  return args;
}

/** Missing paths can still identify a tracked file deleted by the user's edits. */
export async function locateTarget(target: string): Promise<{ repo: string; scope: string[] }> {
  let existing = path.resolve(target);
  const missing: string[] = [];
  let resolved: string;
  for (;;) {
    try { resolved = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const info = await stat(resolved);
  if (!info.isFile() && !info.isDirectory() || missing.length && !info.isDirectory()) throw new Error("Choose a project, directory, or file to review.");
  let repo: string;
  try { repo = await resolveRepository(info.isDirectory() ? resolved : path.dirname(resolved)); }
  catch { throw new Error(`Could not find a Git repository for review path ${JSON.stringify(target)}. Check the path; paths containing spaces can be wrapped in quotes.`); }
  const targetPath = path.join(resolved, ...missing);
  const relative = path.relative(repo, targetPath).split(path.sep).join("/");
  return { repo, scope: relative ? [safeRelativePath(relative)] : [] };
}
