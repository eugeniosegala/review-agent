import { readFile } from "node:fs/promises";
import path from "node:path";
import { nonSourceReason } from "../runtime/review-files.ts";
import type { ReviewContext } from "../shared/types.ts";

const chunkCharacters = 30000;
const batchCharacters = 60000;

export interface SourceChunk {
  id: string;
  path: string;
  revision: "base" | "head";
  equivalentRevision?: "base";
  startLine: number;
  endLine: number;
  content: string;
}
export interface SourceBatch { id: string; domains: string[]; files: string[]; chunks: SourceChunk[] }
interface LiteralLocation { path: string; revision: "base" | "head"; line: number; snippet: string }
export interface LiteralCandidate { value: string; locations: LiteralLocation[] }
export interface SourceInventory {
  batches: SourceBatch[];
  skipped: { path: string; reason: string }[];
  repeatedStrings: LiteralCandidate[];
  literalIndexTruncated: boolean;
  nonSourceFiles: string[];
}

const nonSource = (file: string) => Boolean(nonSourceReason(file));

/** A stable path-level ownership hint; language-specific import analysis remains the agent's job. */
function sourceDomain(file: string): string {
  const parts = file.split("/");
  if (parts.length === 1) return "repository-root";
  if (["src", "lib", "app", "test", "tests"].includes(parts[0]!)) return parts.length === 2 ? `${parts[0]}/root` : parts.slice(0, 2).join("/");
  if (["packages", "apps"].includes(parts[0]!)) return parts.slice(0, 2).join("/");
  return parts[0]!;
}

/** Supply every selected text line; literal matches are search hints, never findings. */
export async function inventorySource(context: ReviewContext, options: { indexRelatedLiterals?: boolean } = {}): Promise<SourceInventory> {
  const chunks: SourceChunk[] = [];
  const skipped: SourceInventory["skipped"] = [];
  const literals = new Map<string, LiteralLocation[]>();
  const indexedHead = new Set<string>();
  const nonSourceFiles: string[] = [];
  let literalIndexTruncated = false;
  const indexLine = (file: string, revision: "base" | "head", line: string, number: number) => {
    for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)) {
      const value = match[2]!;
      if (value.length < 3 || value.length > 300) continue;
      if (!literals.has(value) && literals.size >= 10000) { literalIndexTruncated = true; continue; }
      const locations = literals.get(value) ?? [];
      if (locations.length < 20) locations.push({ path: file, revision, line: number, snippet: line.slice(0, 300) });
      else literalIndexTruncated = true;
      literals.set(value, locations);
    }
  };
  for (const file of context.changedFiles) {
    if (nonSource(file)) {
      nonSourceFiles.push(file);
      skipped.push({ path: file, reason: nonSourceReason(file)! });
      continue;
    }
    const fileChunks: SourceChunk[] = [];
    let failure: string | undefined;
    const sources = await Promise.all((["base", "head"] as const).map(async revision =>
      context.snapshots[revision].files.includes(file) ? readFile(path.join(context.snapshots[revision].directory, file)) : undefined));
    const identical = sources[0] !== undefined && sources[1] !== undefined && sources[0].equals(sources[1]);
    for (const revision of ["base", "head"] as const) {
      if (!context.snapshots[revision].files.includes(file)) continue;
      if (identical && revision === "base") continue;
      const bytes = sources[revision === "base" ? 0 : 1]!;
      let source: string;
      try {
        if (bytes.includes(0)) throw new Error("binary");
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch { failure = "Binary or unsupported text encoding; source review was not performed."; break; }
      const lines = source.split("\n");
      if (revision === "head") indexedHead.add(file);
      if (lines.some(line => line.length > 12000)) { failure = "A source line exceeds the review evidence limit; this file needs a narrower representation."; break; }
      let start = 0;
      let text = "";
      const flush = (end: number) => {
        fileChunks.push({ id: `chunk_${chunks.length + fileChunks.length + 1}`, path: file, revision, ...(identical ? { equivalentRevision: "base" as const } : {}), startLine: start + 1, endLine: end, content: text });
        start = end; text = "";
      };
      for (const [index, line] of lines.entries()) {
        if (text && text.length + line.length + 1 > chunkCharacters) flush(index);
        text += `${line}\n`;
        // Generic lexical hints work across languages. The agent checks their meaning in source.
        indexLine(file, revision, line, index + 1);
        if (identical) indexLine(file, "base", line, index + 1);
      }
      flush(lines.length);
    }
    if (failure || !fileChunks.length) skipped.push({ path: file, reason: failure ?? "Excluded from both source snapshots." });
    else chunks.push(...fileChunks);
  }
  // Code quality uses repository-wide literal hints; other tasks can reuse the bounded source batches without this pass.
  if (options.indexRelatedLiterals !== false) {
    for (const file of context.snapshots.head.files) {
      if (indexedHead.has(file) || nonSource(file)) continue;
      const bytes = await readFile(path.join(context.snapshots.head.directory, file));
      if (bytes.includes(0)) continue;
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        source.split("\n").forEach((line, index) => indexLine(file, "head", line, index + 1));
      } catch { /* Unsupported contextual text is not indexed. */ }
    }
  }
  const batches: SourceBatch[] = [];
  let pending: SourceChunk[] = [];
  let size = 0;
  const flushBatch = () => {
    if (!pending.length) return;
    batches.push({ id: `batch_${batches.length + 1}`, domains: [...new Set(pending.map(chunk => sourceDomain(chunk.path)))],
      files: [...new Set(pending.map(chunk => chunk.path))], chunks: pending });
    pending = []; size = 0;
  };
  const domains = new Map<string, SourceChunk[]>();
  for (const chunk of chunks) {
    const domain = sourceDomain(chunk.path);
    const group = domains.get(domain) ?? [];
    group.push(chunk);
    domains.set(domain, group);
  }
  for (const group of domains.values()) {
    const groupSize = group.reduce((total, chunk) => total + chunk.content.length, 0);
    // Keep a complete source domain together when it fits. This prevents an arbitrary spare-capacity
    // decision from moving one adapter or module into an unrelated batch.
    if (groupSize <= batchCharacters) {
      if (pending.length && size + groupSize > batchCharacters) flushBatch();
      pending.push(...group); size += groupSize;
      continue;
    }
    if (pending.length) flushBatch();
    for (const chunk of group) {
      if (pending.length && size + chunk.content.length > batchCharacters) flushBatch();
      pending.push(chunk); size += chunk.content.length;
    }
  }
  flushBatch();
  const repeatedStrings = [...literals.entries()].filter(([, locations]) => locations.some(location => context.changedFiles.includes(location.path)) && (["base", "head"] as const).some(revision =>
    new Set(locations.filter(location => location.revision === revision).map(location => `${location.path}:${location.line}`)).size >= 2))
    .sort((a, b) => b[1].length - a[1].length).map(([value, locations]) => ({ value, locations }));
  if (repeatedStrings.length > 500) literalIndexTruncated = true;
  return { batches, skipped, repeatedStrings: repeatedStrings.slice(0, 500), literalIndexTruncated, nonSourceFiles };
}
