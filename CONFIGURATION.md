# Configuration

Configuration provides defaults for the agent bridge and review pipeline. Files can contain partial
overrides. Unknown keys and invalid values fail before any model is called.

Precedence is: CLI flags → explicit `--config` file → bundled configuration → application defaults.
The natural-language request can adjust review scope, enabled analyses, dependency installation,
hypothesis and finding budgets, concurrency, and agent/probe timeouts for one run. Infrastructure
settings such as the CLI, model, billing route, retries, batching limits, and assessment policy remain
controlled by configuration.

Defaults in the tables reflect the bundled project configuration. Optional bridge fields show their
application fallback when the bundled configuration omits them.

## Agent and runtime options

| Option | Default | Allowed values | What it controls |
|---|---:|---|---|
| `cli` | `cosine` | `codex`, `cosine`, or a registered bridge | CLI bridge used for every model call. |
| `executable` | Bridge default | Nonempty path or command | Overrides `codex`, `cos`, or the registered bridge executable. Relative paths resolve from the config file. |
| `model` | `lumen-scout` | Nonempty model identifier | Model passed to the selected CLI. Availability and cost depend on the provider. |
| `billingProvider` | `cosine` | `cosine`, `openai` | Expected account charged by Cosine. A detected mismatch stops before the first model call. |
| `structuredOutput` | `auto` | `auto`, `native`, `prompt` | Chooses schema transport. `auto` uses prompt schemas for Lumen or an unspecified/automatic model and native structured output for other configured models. Every response is validated locally. |
| `speed` | `fast` | `standard`, `fast` | Selects the bridge's normal or accelerated transport/service tier. It does not reduce review coverage. |
| `reasoningEffort` | `medium` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Reasoning level requested from the model. The bridge maps unsupported aliases where possible; the chosen model must support the resulting level. |
| `verbosity` | CLI default | `low`, `medium`, `high` | Desired detail in explanatory response fields. Structured evidence remains required at every level. |
| `bridgeModules` | `[]` | Up to 10 local module paths | Loads trusted modules that register additional CLI bridges. |
| `perTaskConcurrency` | `3` | 1–32 | Maximum parallel work items inside each task. Top-level code-quality, preflight, and adversarial investigation can still overlap. |
| `agentTimeoutSeconds` | `300` | 1–3600 | Maximum duration of one planning or model attempt. It is a ceiling; completed calls return immediately. |
| `agentRetries` | `1` | 0–3 | Retries failed planning, analysis, generation, and reporting calls. Assessment uses its dedicated retry policy to avoid multiplying attempts. |
| `agentRetryDelaySeconds` | `2` | 0–30 | Initial delay before a model retry. Later retries use bounded exponential backoff. |

Each model attempt is schema-validated and recorded in `attempts.json`. Retries use separate artifact
directories. Frozen-source integrity is checked around every attempt; mutation and cancellation stop
immediately instead of being retried.

## Preflight task

| Option | Default | Allowed values | What it controls |
|---|---:|---|---|
| `tasks.preflight.installDependencies` | `true` | Boolean | Allows missing Node dependencies to be installed in a private setup copy. Existing target dependencies are reused first. Preflight remains advisory and never blocks adversarial attempts. |
| `tasks.preflight.dependencySetupTimeoutSeconds` | `300` | 1–3600 | Maximum time for one private dependency setup attempt. |

## Code-quality task

| Option | Default | Allowed values | What it controls |
|---|---:|---|---|
| `tasks.codeQuality.enabled` | `true` | Boolean | Enables review for duplicated logic and strings, hardcoded constants, reuse opportunities, and mixed responsibilities. |
| `tasks.codeQuality.maxFindingsPerBatch` | `10` | 1–20 | Maximum findings requested from each source batch. A capped batch is reported as incomplete when more supported findings remain. |
| `tasks.codeQuality.maxBatches` | `64` | 1–256 | Safety ceiling for deterministic source batching. It does not intentionally sample files; exceeding it makes coverage incomplete. |

## Adversarial task

| Option | Default | Allowed values | What it controls |
|---|---:|---|---|
| `tasks.adversarial.enabled` | `true` | Boolean | Enables behavioral investigation, generated probes, execution on both revisions, and evidence assessment. At least one analysis task must remain enabled. |
| `tasks.adversarial.maxHypotheses` | `6` | 1–20 | Global maximum behavioral hypotheses retained after all investigation batches are consolidated. |
| `tasks.adversarial.maxInvestigationBatches` | `64` | 1–256 | Safety ceiling for deterministic source investigation batches. Exceeding it is disclosed as incomplete coverage. |
| `tasks.adversarial.maxExperimentsPerHypothesis` | `1` | 1–3 | Maximum complementary executable probes generated for each supported hypothesis. |
| `tasks.adversarial.probeTimeoutSeconds` | `120` | 1–3600 | Maximum runtime of one probe on one revision. A timeout becomes execution evidence, not an application defect by itself. |
| `tasks.adversarial.assessmentConcurrency` | `2` | 1–8 | Maximum hypotheses assessed by the model at the same time. |
| `tasks.adversarial.assessmentRetries` | `1` | 0–3 | Per-hypothesis assessment retries after timeout, invalid output, or provider failure. Completed assessments are preserved. |
| `tasks.adversarial.probeRepairAttempts` | `1` | 0–3 | Bounded regeneration attempts when generated probes produce only setup or runtime errors. |
| `tasks.adversarial.assessmentTimeoutSeconds` | `300` | 1–3600 | Maximum duration of one hypothesis assessment attempt, capped by `agentTimeoutSeconds`. |

## Example

```json
{
  "cli": "cosine",
  "model": "lumen-scout",
  "billingProvider": "cosine",
  "structuredOutput": "auto",
  "speed": "fast",
  "reasoningEffort": "medium",
  "perTaskConcurrency": 3,
  "agentTimeoutSeconds": 300,
  "agentRetries": 1,
  "agentRetryDelaySeconds": 2,
  "tasks": {
    "preflight": {
      "installDependencies": true,
      "dependencySetupTimeoutSeconds": 300
    },
    "codeQuality": {
      "enabled": true,
      "maxFindingsPerBatch": 10,
      "maxBatches": 64
    },
    "adversarial": {
      "enabled": true,
      "maxHypotheses": 6,
      "maxInvestigationBatches": 64,
      "maxExperimentsPerHypothesis": 1,
      "probeTimeoutSeconds": 120,
      "assessmentConcurrency": 2,
      "assessmentRetries": 1,
      "probeRepairAttempts": 1,
      "assessmentTimeoutSeconds": 300
    }
  }
}
```

## CLI overrides

The command line supports `--config`, `--cli`, `--cli-path`, `--model`, `--speed`,
`--reasoning-effort`, `--verbosity`, `--billing-provider`, `--structured-output`, and repeatable
`--bridge-module`. Put `--` before review prose that begins with a flag-like value.
