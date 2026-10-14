import type { Prerequisite, ReviewContext } from "../../shared/types.ts";

export function preflightPrompt(skill: string, context: ReviewContext, builtins: Prerequisite[] = []): string {
  return `${skill}

Task: PREFLIGHT. Inspect base/, head/, change.diff, and executor-context.json. Do not execute code,
write files, install dependencies, or fetch anything. Return prerequisite inventory and check payloads
in the supplied schema; the runner executes them separately in private copies of the same snapshots.
Selected review paths: ${JSON.stringify(context.changedFiles)}.
These paths select WHAT to test; both snapshots contain the FULL application, including manifests,
unchanged imports, entry points, configuration schemas, and test infrastructure. Setup is not scoped
to changed files. Choose actual executable probes for the user's selected behavior.
Deterministic Node prerequisites already provided by the runner: ${JSON.stringify(builtins.map(({ check, ...requirement }) => requirement))}.
Do not duplicate these runtime/package checks. Return supplementary requirements only; an empty
requirements array is valid when the built-in checks suffice. Other stacks still need runtime checks.
Never use npm ls in a source copy to infer dependency absence: installed packages resolve through
ancestor directories. Never demand a Volta pin by equality as proof of compatibility; the executor
selects an installed application pin and verifies actual package engine constraints.
Excluded template/configuration paths are not evidence that they are missing from the original project.
Include required runtime checks covering BOTH base and head, even for a dependency-free module.
Use sources with exact repository-relative paths and the corresponding revision.
Return examinedFiles as an audit receipt containing every repository source file you actually read
while deriving the approach and requirements. Return skippedFiles only for source files you deliberately
considered but could not inspect, with a concrete reason. Do not list unread files merely because they
exist in the snapshots. Use exact repository-relative snapshot paths in both fields.
Group package checks when appropriate so the inventory fits within 20 requirements.
For unavailable or unsupported verification set check:null and explain the gap in remediation.
The runner reuses installed Node dependencies first and conditionally installs missing packages
in a separate private setup copy. Do not install inside check payloads or repeat a working setup.

Check protocol (same executor/environment as adversarial probes):
- cwd and REVIEW_REPO point to the copied source; REVIEW_EXPERIMENTS points to your frozen check files.
- Prefer a minimal startup/service smoke check and tool availability over running an entire
  repository test suite during environment preparation. Keep adversarial validation in its task.
- Tool caches and build output must also use scratch. Vitest requires --no-cache (TMPDIR alone
  does not stop its source-local results cache); pytest needs -p no:cacheprovider and Python
  imports must disable bytecode writes or route them to scratch. Inspect other tools' defaults.
- REVIEW_SCRATCH is writable. Source and check files must remain unchanged. No installation or provisioning.
- argv uses {{repo}} and {{experiments}} placeholders, with no shell interpolation.
- PATH, LANG, TZ and these review paths are supplied. Host environment variables, HOME, credentials,
  runtime injection flags, and secret configuration files are not forwarded.
- The runner's Node executable is available as a verification launcher even for other target stacks.
  Use it to wrap tool/version checks when necessary, catching ENOENT and failed imports explicitly.
- Emit exactly one REVIEW_AGENT_OBSERVATION: JSON line with status, expected, actual, details.
  Strings must be nonempty. pass + exit 0 means available and compatible; violation + exit 1 means
  a positively observed missing/incompatible prerequisite; error + exit 2 means verification failed.
  Crashes, timeouts, and missing observations remain unknown. Diagnostics never gate adversarial attempts.
- Checks for services or startup should test an isolated local test environment, never production.
  Do not start the application before confirming its prerequisites within the check.
- parallelSafe:true is only for independent read-only checks with private scratch space and ephemeral
  ports. Shared-resource checks run serially. Always clean up any server or child process you start.

Describe a concrete approach for subsequent probes. Missing optional integrations must be identified
so the adversarial task can avoid them. Do not claim readiness from source inspection alone.
`;
}
