import { realpath } from "node:fs/promises";
import path from "node:path";
import { assertSnapshotUnchanged, exportSnapshot, readGit } from "./repository.ts";
import { copySnapshot } from "./working-tree.ts";
import { referenceDirectory } from "./source.ts";
import type { Snapshot } from "../shared/types.ts";

/** One retained source per requested revision; reuse the request's freeze and identical refs. */
export async function prepareSnapshots(repo: string, refs: { base: string; head: string }, directory: string,
  workspace: string, candidates: Snapshot[]) {
  const store = path.join(await realpath(directory), "artifacts", "snapshots");
  candidates = await Promise.all(candidates.map(async snapshot => ({ ...snapshot,
    directory: path.join(await realpath(path.dirname(snapshot.directory)), path.basename(snapshot.directory)),
  })));
  const committed = [...new Set([refs.base, refs.head, ...candidates.map(snapshot => snapshot.commit)])]
    .filter(ref => /^[a-f0-9]{40,64}$/.test(ref));
  const trees = new Map<string, string>();
  if (committed.length > 1) {
    const values = (await readGit(repo, ["rev-parse", ...committed.map(ref => `${ref}^{tree}`)])).toString("utf8").trim().split("\n");
    if (values.length !== committed.length || values.some(value => !/^[a-f0-9]{40,64}$/.test(value))) throw new Error("Invalid committed source tree IDs");
    committed.forEach((ref, index) => trees.set(ref, values[index]!));
  }
  const pending = new Map<string, Promise<Snapshot>>();
  const retained = new Set<string>();
  const externalCopies = new Map<string, Promise<Snapshot>>();
  const insideRun = (source: string) => {
    const relative = path.relative(store, source);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  };
  const load = (ref: string) => {
    const key = trees.get(ref) ?? ref;
    if (!pending.has(key)) pending.set(key, (async () => {
      const frozen = candidates.find(snapshot => snapshot.commit === ref) ??
        (trees.has(ref) ? candidates.find(snapshot => trees.get(snapshot.commit) === trees.get(ref)) : undefined);
      const destination = path.join(store, frozen ? `source-${frozen.sha256}` : `commit-${ref}`);
      let snapshot: Snapshot;
      if (frozen) {
        await assertSnapshotUnchanged(frozen);
        // Follow an owned clean-working-tree alias to keep just one physical source.
        const source = await realpath(frozen.directory);
        if (insideRun(source)) snapshot = { ...frozen, directory: source };
        else {
          if (!externalCopies.has(frozen.sha256)) externalCopies.set(frozen.sha256, copySnapshot(frozen, destination));
          snapshot = { ...frozen, directory: (await externalCopies.get(frozen.sha256)!).directory };
        }
      } else snapshot = await exportSnapshot(repo, ref, destination);
      retained.add(path.resolve(snapshot.directory));
      return snapshot;
    })());
    return pending.get(key)!.then(snapshot => ({ ...snapshot, commit: ref }));
  };
  const outcomes = await Promise.allSettled([load(refs.base), load(refs.head)]);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  const base = (outcomes[0] as PromiseFulfilledResult<Snapshot>).value;
  let head = (outcomes[1] as PromiseFulfilledResult<Snapshot>).value;
  const redundant: string[] = [];
  if (head.sha256 === base.sha256 && head.directory !== base.directory) {
    redundant.push(head.directory);
    retained.delete(path.resolve(head.directory));
    head = { ...head, directory: base.directory };
  }
  // Prune only after other users of the request freeze (including diff generation) settle.
  const discarded = candidates.filter(snapshot => insideRun(snapshot.directory) && !retained.has(path.resolve(snapshot.directory)))
    .map(snapshot => snapshot.directory).concat(redundant);
  const targets = { base: base.directory, head: head.directory };
  await Promise.all([
    referenceDirectory(base.directory, path.join(workspace, "base")),
    referenceDirectory(head.directory, path.join(workspace, "head")),
  ]);
  return { snapshots: {
    base: { ...base, directory: path.join(workspace, "base") },
    head: { ...head, directory: path.join(workspace, "head") },
  }, targets, count: retained.size, discarded };
}
