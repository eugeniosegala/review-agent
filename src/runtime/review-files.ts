import path from "node:path";

const dependencyLocks = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "Pipfile.lock", "poetry.lock", "uv.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum"]);

/** These files remain in the application snapshot, but are not authored source. */
export function nonSourceReason(file: string): string | undefined {
  const name = path.basename(file);
  if (/^(LICEN[CS]E|COPYING|NOTICE)(\.(txt|md|rst))?$/i.test(name)) return "License or notice text; retained as contextual metadata rather than executable application source.";
  if (dependencyLocks.has(name)) return "Generated dependency lock metadata; setup checks handle dependency availability and declared versions.";
  if ([".DS_Store", ".gitkeep"].includes(name)) return "Not source text: filesystem metadata or non-executable directory placeholder.";
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|mp3|mp4|wav|wasm)$/i.test(file)) return "Binary asset; excluded from static source examination and retained for application execution.";
  return undefined;
}
