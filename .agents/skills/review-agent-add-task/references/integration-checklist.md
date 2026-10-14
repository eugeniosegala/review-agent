# Review task integration checklist

Use this checklist as a coverage map. Discover the current extension points with search before editing; names may move as the architecture evolves.

## 1. Discover the current contracts

Locate the definitions and call sites for:

- task, analysis, stage, lifecycle, and timing identifiers;
- task results and the aggregate review report;
- task-bound context and runtime-skill resolution;
- configuration types, defaults, strict schema validation, extraction, and the explicit nested merge in configuration resolution;
- natural-language planning prompt, response schema, plan validation, and plan-to-review option mapping;
- task registration, selection, concurrent scheduling, prerequisite boundaries, and lifecycle publication;
- source inventory, frozen references, pooled execution workspaces, and shared probe execution;
- per-task rendering, aggregate report input and narrative schema, live publication, and final status calculation;
- the fixture bridge, provider registry, demo fixture, CLI summaries, and focused tests.

A useful starting search is:

```sh
rg -n "TaskName|AnalysisName|Stage|TaskResult|ReviewReport|taskNames|createTaskRuns|analysisNames|skillFolders|TaskSettings|defaultReviewSettings|configSchema|planSchema|saveTaskProgress|runReporting|FixtureBridge" src test scripts
```

Run the existing checks before substantial changes when practical. Do not hide a pre-existing failure by weakening validation or tests.

The current integration seams are deliberately explicit. Expect coordinated edits around shared types, review options, task context, task runner, review orchestration, configuration schema and merge logic, request planning, report rendering/input, and test fixtures. A task implementation belongs under `src/tasks/`; its model judgment belongs under `skills/`. Task code reaches Codex, Cosine, or another CLI only through `TaskContext.invoke`. Built-in CLI adapters are exported from `src/bridges/providers/index.ts`, and model-specific compatibility belongs inside that provider's model subfolder; adding an ordinary task should not require provider-specific branches.

## 2. Define one task contract

- Add the task identifier to the central task vocabulary. Add it to the analysis vocabulary only when users can select it as an analysis; prerequisites and final reporting are tasks but are not analyses.
- Define a specific structured result instead of a generic untyped payload.
- Define the task's statuses, evidence types, coverage receipt, errors, and limitations.
- Add only the agent stages the task actually needs, and reflect custom stages in both the shared stage type and task-context stage mapping.
- Decide whether the task reads frozen source, runs commands, mutates a leased copy, or depends on another task.
- State what qualifies as a finding. A model assertion alone is not executable evidence.

Prefer shared interfaces for genuinely common mechanics. Keep task-specific semantics in the task module.

## 3. Add the runtime behavior

- Create a dedicated task module with a narrow public entry point.
- Add a runtime skill containing the task's review judgment and evidence rules.
- Register the runtime skill in the task context rather than reading it in task code or embedding it in prompts.
- Add strict schemas for every model response and validate before execution or reporting.
- Reuse the shared source inventory for bounded source batches when its semantics fit. Otherwise build a deterministic manifest with the same examined, skipped, and unreported coverage receipt.
- Use the shared process/probe layer for commands so timeouts, output limits, environment handling, and evidence capture stay consistent.
- Use `TaskContext.invoke` for model calls so retries, timeouts, artifacts, events, user intent, and frozen-source checks stay consistent. Assert source integrity around any additional execution boundary.
- Store task context and agent artifacts under the task namespace. Do not write generated evidence into the reviewed repository or shared frozen snapshots.

Do not duplicate Git resolution, snapshotting, process spawning, schema validation, concurrency queues, or report writes inside the task.

## 4. Make the task selectable and configurable

- Teach the natural-language planner when to select or omit the task and how user wording changes its focus. Preserve the user's requested target: working tree, commit, branch, path, or full repository.
- Extend the plan schema, deterministic plan validation, and plan-to-review mapping for the new analysis and any supported request-level budget.
- Respect both the task's `enabled` configuration and explicit natural-language selection rules used by the product.
- Add defaults and strict config validation under `tasks.<taskKey>`.
- Update the typed settings, default settings, schema, nested configuration merge, extracted review settings, and review options together. Reuse central numeric limits; add a named bounded limit only for a genuinely new dimension.
- Preserve configuration precedence: defaults, config file, then supported per-run request overrides.

Keep provider and model settings shared unless the product explicitly supports per-task agent settings.

## 5. Schedule it concurrently

- Register a lifecycle entry before work begins so the live report shows pending, running, and terminal states.
- Add the task to selection and lifecycle logic, then launch all selected independent analysis promises together and settle them before final reporting.
- For a prerequisite, launch the task's independent inspection and the prerequisite concurrently. Await the prerequisite only before the dependent operation.
- Use the configured concurrency bounds for internal fan-out.
- Publish terminal output in `finally`, including incomplete tasks.
- Preserve sibling results when the task throws, times out, or returns malformed output.
- Make final reporting wait for every selected task. Calculate aggregate completion from every selected analysis, cleanup, and report-generation outcome rather than from the original hard-coded task pair.

Measure concurrency with a barrier or controlled delays in a test; elapsed-time assertions alone are brittle.

## 6. Integrate reports and artifacts

- Render a dedicated live task report from the typed result and lifecycle state.
- Include the evaluated-file receipt and distinguish examined, skipped, and unreported files.
- Store task artifacts only in its task namespace.
- Add the task to the aggregate JSON report without discarding structured evidence.
- Extend aggregate report input, narrative source identifiers, priority validation, overview counts, and task links where the task contributes findings. The final narrative may summarize validated results; it must not invent findings or change task status.
- Keep partial results inspectable when later stages fail.
- Keep task filenames, titles, and render dispatch exhaustive over the task-name union so adding a task cannot silently omit its report.

## 7. Prove the extension

Add focused tests for the applicable behaviors:

- natural-language selection and omission;
- config defaults, nested merges, overrides, unknown keys, and numeric bounds;
- structured-response rejection;
- deterministic file scope and coverage accounting;
- concurrent start with sibling tasks;
- prerequisite ordering only at the dependency boundary;
- live and final per-task report publication;
- task failure isolation and aggregate incomplete status;
- artifact namespace and frozen-source integrity;
- offline end-to-end behavior through the fixture bridge, including every new stage;
- provider independence: the task uses the shared bridge request and does not branch on Codex or Cosine.

Run:

```sh
npm run check
npm run demo
```

The work is complete only when the task can be requested in natural language, runs through the standard pipeline, produces an inspectable task report, and passes the relevant checks.
