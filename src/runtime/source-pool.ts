import { lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { assertSnapshotUnchanged } from "./repository.ts";
import { cloneDirectory } from "./source.ts";
import type { Snapshot } from "../shared/types.ts";

interface Slot { directory: string; busy: boolean; digest?: string }

/** Exclusive leases reuse verified source between jobs, never between active jobs. */
export class SourcePool {
  readonly stats = { executionCopiesCreated: 0, executionCopiesReused: 0, peakExecutionCopies: 0 };
  private slots: Slot[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  private directory: string;
  private limit: number;

  constructor(directory: string, limit: number) {
    this.directory = directory;
    this.limit = limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error("Source pool size must be between 1 and 32");
  }

  async use<T>(snapshot: Snapshot, dependencies: string | undefined, operation: (copy: Snapshot) => Promise<T>): Promise<T> {
    let slot: Slot | undefined;
    while (!slot) {
      if (this.closed) throw new Error("Source pool is closed");
      slot = this.slots.find(candidate => !candidate.busy && candidate.digest === snapshot.sha256);
      if (!slot) slot = this.slots.find(candidate => !candidate.busy && !candidate.digest);
      if (!slot && this.slots.length < this.limit) {
        slot = { directory: path.join(this.directory, `slot-${this.slots.length + 1}`), busy: false };
        this.slots.push(slot);
        this.stats.peakExecutionCopies = Math.max(this.stats.peakExecutionCopies, this.slots.length);
      }
      // Keep cached revisions when capacity allows, including serial base/head jobs.
      if (!slot && !this.slots.some(candidate => candidate.busy && candidate.digest === snapshot.sha256)) {
        slot = this.slots.find(candidate => !candidate.busy);
      }
      if (slot) slot.busy = true;
      else await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    const copy = { ...snapshot, directory: path.join(slot.directory, "source") };
    try {
      await mkdir(this.directory, { recursive: true });
      if (!(await lstat(this.directory)).isDirectory()) throw new Error("Execution workspace root was modified");
      await mkdir(slot.directory, { recursive: true });
      if (!(await lstat(slot.directory)).isDirectory()) throw new Error("Execution workspace slot was modified");
      await assertSnapshotUnchanged(snapshot);
      if (slot.digest !== snapshot.sha256) {
        await rm(copy.directory, { recursive: true, force: true });
        slot.digest = undefined;
        await cloneDirectory(snapshot.directory, copy.directory);
        await this.verify(copy);
        slot.digest = snapshot.sha256;
        this.stats.executionCopiesCreated++;
      } else {
        await this.verify(copy);
        this.stats.executionCopiesReused++;
      }
      // Refresh the resolution hierarchy too: a prior job must not leave a package
      // manifest, dependency link, or other sibling file that changes the next probe.
      for (const entry of await readdir(slot.directory)) {
        if (entry !== "source") await rm(path.join(slot.directory, entry), { recursive: true, force: true });
      }
      if (dependencies) await symlink(path.join(dependencies, "node_modules"), path.join(slot.directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      try { return await operation(copy); }
      finally { await this.verify(copy); }
    } catch (error) {
      // Even a failed executor may have changed source. Never hand that copy to another job.
      slot.digest = undefined;
      if ((await lstat(this.directory).catch(() => null))?.isDirectory()) await rm(slot.directory, { recursive: true, force: true });
      else await rm(this.directory, { force: true });
      throw error;
    } finally {
      slot.busy = false;
      for (const wake of this.waiters.splice(0)) wake();
    }
  }

  private async verify(copy: Snapshot): Promise<void> {
    for (const directory of [this.directory, path.dirname(copy.directory), copy.directory]) {
      if (!(await lstat(directory)).isDirectory()) throw new Error("Execution source snapshot was modified: directory replaced with a reference or special file");
    }
    await assertSnapshotUnchanged(copy);
  }

  async close(): Promise<void> {
    if (this.slots.some(slot => slot.busy)) throw new Error("Cannot clean up active source leases");
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
    await rm(this.directory, { recursive: true, force: true });
  }
}
