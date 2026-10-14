export type TaskName = "preflight" | "code-quality" | "adversarial" | "report";
export type AnalysisName = Extract<TaskName, "code-quality" | "adversarial">;
export type Stage = TaskName | "investigate" | "generate" | "assess" | "plan";
export type Severity = "high" | "medium" | "low";
export type JsonSchema = Record<string, unknown>;

/** The application contract. CLI names, flags and wire events belong to bridges. */
export interface AgentRequest {
  task: TaskName | "request";
  stage: Stage;
  prompt: string;
  schema: JsonSchema;
  workspace: string;
  artifacts: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentEvent {
  task: TaskName | "request";
  kind: "started" | "progress" | "completed";
  stage: Stage;
  message: string;
}

export interface AgentBridge {
  readonly name: string;
  readonly supportedSettings?: readonly ("model" | "speed" | "reasoningEffort" | "verbosity")[];
  /** Human-readable account that the configured CLI is expected to charge. */
  readonly billingRoute?: string;
  run(request: AgentRequest): Promise<unknown>;
}

export interface Hypothesis {
  id: string;
  title: string;
  severity: Severity;
  claim: string;
  invariant: string;
  expectationSource: string;
  changedFiles: string[];
  testIdea: string;
}

export interface Investigation {
  hypotheses: Hypothesis[];
  examinedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
  notes: string[];
}

export interface Experiment {
  id: string;
  hypothesisId: string;
  description: string;
  parallelSafe: boolean;
  files: { path: string; content: string }[];
  argv: string[];
}

export interface Generation {
  experiments: Experiment[];
  skipped: { hypothesisId: string; reason: string }[];
}

/** A probe emits exactly one prefixed JSON line; a crash is not a violation. */
export interface Observation {
  status: "pass" | "violation" | "error";
  expected: string;
  actual: string;
  details: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimited: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ExecutionEvidence {
  id: string;
  experimentId: string;
  hypothesisId: string;
  revision: "base" | "head";
  commit: string;
  argv: string[];
  resolvedArgv: string[];
  payloadSha256: string;
  executor: string;
  runtime: { nodeVersion: string; platform: string; architecture: string };
  result: ProcessResult;
  observation: Observation | null;
  outcome: "pass" | "violation" | "error";
  stdoutPath: string;
  stderrPath: string;
}

export interface Assessment {
  findings: {
    hypothesisId: string;
    verdict: "defect" | "unsupported" | "inconclusive";
    confidence: "high" | "medium" | "low";
    explanation: string;
    expectationJustification: string;
    evidenceIds: string[];
  }[];
}

export type FindingStatus = "reproduced_regression" | "pre_existing" | "not_reproduced" | "inconclusive";

export interface Finding {
  hypothesis: Hypothesis;
  status: FindingStatus;
  confidence: "high" | "medium" | "low";
  explanation: string;
  expectationJustification: string;
  evidenceIds: string[];
}

export interface ReviewOptions {
  repo: string;
  base: string;
  head: string;
  out: string;
  /** Reuse the run directory allocated before request planning. */
  runDirectory?: string;
  focus: string[];
  instructions?: string;
  analyses?: AnalysisName[];
  workingTree?: WorkingTreeCapture;
  /** Frozen inputs captured during request planning, eligible for reuse. */
  frozenSnapshots?: Snapshot[];
  reviewScope?: "changes" | "all";
  comparison?: "working-tree" | "commit" | "branch" | "repository";
  installDependencies?: boolean;
  maxHypotheses: number;
  maxExperimentsPerHypothesis?: number;
  maxQualityFindings?: number;
  maxCodeQualityBatches?: number;
  maxAdversarialInvestigationBatches?: number;
  perTaskConcurrency?: number;
  agentTimeoutMs: number;
  agentRetries?: number;
  agentRetryDelayMs?: number;
  experimentTimeoutMs: number;
  assessmentConcurrency?: number;
  assessmentRetries?: number;
  probeRepairAttempts?: number;
  assessmentTimeoutMs?: number;
  dependencySetupTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface WorkingTreeCapture {
  base: Snapshot;
  head: Snapshot;
  changedFiles: string[];
}

export interface Snapshot {
  commit: string;
  directory: string;
  files: string[];
  excluded: { path: string; reason: string }[];
  sha256: string;
}

export interface SourcePoolStats {
  executionCopiesCreated: number;
  executionCopiesReused: number;
  peakExecutionCopies: number;
}

/** Runtime capability used by probe orchestration; implementations remain outside shared contracts. */
export interface SourceWorkspacePool {
  readonly stats: SourcePoolStats;
  use<T>(snapshot: Snapshot, dependencies: string | undefined, operation: (copy: Snapshot) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CoverageEntry {
  applicable?: boolean;
  path: string;
  status: "examined" | "skipped" | "unreported";
  reason: string;
}

export interface FileExamination {
  examinedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
}

export interface TaskResult {
  status: "completed" | "incomplete";
  errors: string[];
}

export interface Prerequisite {
  id: string;
  category: "runtime" | "package" | "build" | "configuration" | "service" | "startup";
  description: string;
  required: boolean;
  revisions: ("base" | "head")[];
  sources: { revision: "base" | "head"; path: string }[];
  remediation: string;
  check: { parallelSafe: boolean; files: { path: string; content: string }[]; argv: string[] } | null;
}

export interface PreflightDiscovery extends FileExamination {
  approach: string;
  requirements: Prerequisite[];
  notes: string[];
}

export interface PreflightResult extends TaskResult {
  readiness: "ready" | "blocked";
  discovery: PreflightDiscovery | null;
  checks: { requirementId: string; revision: "base" | "head"; outcome: "available" | "missing" | "unknown"; reason: string; evidence: ExecutionEvidence | null }[];
  setup?: { revision: "base" | "head"; directory: string; status: "completed" | "incomplete"; dependencyRoot: string | null; reason: string; result: ProcessResult | null }[];
}

export interface CodeQualityFinding {
  id: string;
  title: string;
  category: "duplication" | "duplicate-string" | "hardcoded-constant" | "reuse" | "responsibility";
  origin: "introduced" | "pre_existing";
  severity: Severity;
  explanation: string;
  recommendation: string;
  changedFiles: string[];
  locations: { revision: "base" | "head"; path: string; line: number; snippet: string }[];
}

export interface CodeQualityReview extends FileExamination {
  findings: CodeQualityFinding[];
  reviewedChunks: string[];
  moreFindings: boolean;
  notes: string[];
}

export interface CodeQualityResult extends TaskResult {
  findings: CodeQualityFinding[];
  coverage: CoverageEntry[];
  notes: string[];
  batches: { id: string; status: "completed" | "incomplete"; domains: string[]; files: string[]; suppliedChunks: string[]; reviewedChunks: string[]; errors: string[] }[];
}

export interface AdversarialResult extends TaskResult {
  investigation: Investigation | null;
  generation: Generation | null;
  evidence: ExecutionEvidence[];
  findings: Finding[];
  coverage: CoverageEntry[];
}

export interface ReportNarrative {
  summary: string;
  priorities: { source: "code-quality" | "adversarial"; findingId: string; reason: string }[];
  notes: string[];
}

export interface ReportingResult extends TaskResult {
  narrative: ReportNarrative | null;
}

export interface TaskRun {
  name: TaskName;
  status: "pending" | "running" | "completed" | "incomplete" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  errors: string[];
  durationMs?: number;
}

export interface ReviewTimings {
  preparationMs: number;
  totalMs: number;
  agentCalls: { task: TaskName; stage: Stage; artifactId?: string; durationMs: number }[];
}

export interface ReviewContext {
  repo: string;
  base: string;
  head: string;
  changedFiles: string[];
  snapshots: { base: Snapshot; head: Snapshot };
  diffTruncated: boolean;
  workspace: string;
  directory: string;
  timings?: ReviewTimings;
  sourcePool?: SourceWorkspacePool;
  snapshotTargets?: Record<"base" | "head", string>;
  preflight?: PreflightResult;
  dependencyRoots?: Partial<Record<"base" | "head", string>>;
}

export interface ReviewReport {
  version: 2;
  runId: string;
  bridge: string;
  status: "running" | "completed" | "incomplete";
  startedAt: string;
  finishedAt: string;
  repo: string;
  base: string;
  head: string;
  focus: string[];
  instructions?: string;
  changedFiles: string[];
  reviewFiles: string[];
  comparison: "working-tree" | "commit" | "branch" | "repository";
  reviewScope: "changes" | "all";
  timings?: ReviewTimings;
  storage?: { frozenSourceCopies: number } & SourcePoolStats;
  snapshots: { base: Snapshot; head: Snapshot } | null;
  diffTruncated: boolean;
  tasks: TaskRun[];
  preflight: PreflightResult | null;
  codeQuality: CodeQualityResult | null;
  adversarial: AdversarialResult | null;
  reporting: ReportingResult | null;
  errors: string[];
  limitations: string[];
}

export interface ExperimentRequest {
  experiment: Experiment;
  snapshot: Snapshot;
  revision: "base" | "head";
  payloadDirectory: string;
  artifacts: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExperimentExecutor {
  readonly name: string;
  readonly context?: Record<string, unknown>;
  execute(request: ExperimentRequest): Promise<ExecutionEvidence>;
}
