---
name: review-agent-add-task
description: Add a first-class review task to this review-agent project from a natural-language description. Use when extending the review pipeline with a separate analysis, check, or evidence-producing task that must follow the existing configuration, scheduling, isolation, reporting, and test architecture.
---

# Add a review task

Turn the user's description into a complete, reviewable task integration. The task must be selectable through the natural-language request, independently configurable, visible in live reports, and scheduled concurrently with other independent analysis tasks.

Read [the integration checklist](references/integration-checklist.md) before editing. Inspect the current implementation rather than assuming that paths or contracts have stayed unchanged.

## Establish the contract

Infer a concrete contract from the request:

- one stable kebab-case task name and camelCase configuration key;
- the question the task answers and the evidence required to answer it;
- applicable files, deterministic inputs, structured result, and completion states;
- model stages, executable work, explicit prerequisites, and resource limits;
- task-specific configuration with safe defaults.

Use reasonable defaults when the intent is clear. Ask only when a missing product decision would materially change the task's meaning or safety.

## Preserve the architecture

- Keep this project skill separate from runtime task skills. Put task judgment used during reviews in the runtime skill system already used by the pipeline.
- Give the task a dedicated implementation and result contract. Reuse shared runners, validation, limits, source workspaces, probes, coverage, and reporting helpers.
- Keep task code provider-agnostic. Invoke the configured agent through the task context and shared bridge contract; built-in CLI implementations and their export point live under `src/bridges/providers/`.
- Let the model inspect, prioritize, and explain. Keep selection, schemas, validation, command execution, timeouts, status, and evidence classification deterministic.
- Validate every model response before using it. Treat malformed or unsupported output as an incomplete task, never as a successful finding.
- Reuse the frozen snapshots created for the review. Use private pooled execution copies only when the task can mutate source or dependencies.
- Start every selected independent task in the same concurrent analysis phase. If the task has a prerequisite, start independent investigation immediately and await the prerequisite only at the execution boundary.
- Isolate failures. One incomplete task must still publish its report and must not prevent sibling tasks from finishing.
- Give the task its own live Markdown report, evaluated-file receipt, artifacts, timing, errors, and final report section.
- Put shared agent settings at the configuration root and task controls under `tasks.<taskKey>`. Reject unknown keys and invalid ranges.

## Finish the integration

Implement every applicable item in the checklist. Add focused tests for selection, concurrency, validation, configuration, reporting, and failure isolation. Update the concise user documentation only where behavior, configuration, or invocation changed.

Run `npm run check`. Run `npm run demo` when the new task participates in the default pipeline or changes the aggregate report. Report the behavior added, the architectural extension points changed, the verification performed, and any real limitations.
