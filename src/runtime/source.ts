import { constants } from "node:fs";
import { cp, lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import path from "node:path";

/** Independent writes, with shared disk blocks on filesystems supporting reflinks. */
export async function cloneDirectory(source: string, destination: string): Promise<void> {
  await cp(await realpath(source), destination, { recursive: true, mode: constants.COPYFILE_FICLONE });
}

/** Workspace navigation references contain no additional source bytes. */
export async function referenceDirectory(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const existing = await lstat(destination).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) { await assertReferenceUnchanged(destination, source); return; }
  const parent = await realpath(path.dirname(destination));
  const target = path.join(await realpath(path.dirname(source)), path.basename(source));
  await symlink(process.platform === "win32" ? target : path.relative(parent, target),
    destination, process.platform === "win32" ? "junction" : "dir");
}

export async function assertReferenceUnchanged(reference: string, target: string): Promise<void> {
  const parent = await realpath(path.dirname(reference));
  const expected = path.join(await realpath(path.dirname(target)), path.basename(target));
  if (!(await lstat(reference)).isSymbolicLink() ||
      path.resolve(parent, await readlink(reference)) !== expected) {
    throw new Error(`Source workspace reference was modified: ${reference}`);
  }
}
