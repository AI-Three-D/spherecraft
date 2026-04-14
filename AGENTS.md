# AGENTS.md

This repository uses a task-folder-based autonomous workflow.

## Roles

- **Codex** is the implementer.
- **Claude Code** is the reviewer and architect.
- The local Python orchestrator (`orchestrate.py`) is the turn-taking controller.

Codex must not decide on its own to skip review gates, skip validation, or begin future increments.

## Standard execution path

When the user asks to run a substantial task autonomously:

1. Infer a short stable task slug.
2. Create `tasks/<task-slug>/` if it does not exist.
3. Write the raw request to `tasks/<task-slug>/task.md`.
4. Use the orchestrator as the canonical entry point.

Canonical command:

```bash
python orchestrate.py prep-and-run --task "<raw task>"
```

If the task folder already exists and the task should continue, use the existing folder and resume through the orchestrator commands instead of inventing a parallel workflow.

## Task folder contract

Each autonomous task lives under:

```text
tasks/<task-slug>/
```

Expected files:

- `task.md` — raw user request
- `refined-task.md` — tightened brief after viability analysis
- `plan.json` — staged implementation plan
- `plan-review.json` — reviewer decision on the plan
- `current-increment.json` — current increment spec
- `codex-handoff.json` — implementer summary for review
- `claude-review.json` — reviewer decision on the increment
- `state.json` — orchestrator state
- `run.log` — append-only progress log

## Intake and viability analysis

Before unattended implementation:

- tighten the task into a short concrete brief
- identify missing requirements
- ask only the minimum clarifying questions needed to proceed safely
- recommend a validation strategy based on the prompt and repo shape

Good reasons to pause for clarification:

- acceptance criteria are unclear
- UI expectations are vague and no screenshot or mockup target exists
- migration / rollout / backward-compatibility impact is ambiguous
- there are multiple plausible architectural approaches with materially different outcomes

## Planning rules

The plan must be broken into small, reviewable increments.

Each increment should have:

- a stable `id`
- a short title
- one clear goal
- narrow scope
- explicit validation steps
- explicit done conditions

Avoid increments that combine multiple architectural shifts at once.

## Implementation rules

When implementing an increment:

- implement only the current approved increment
- do not start future increments
- preserve the invariants from the plan and review files
- stop after producing the handoff summary
- record what changed, what was validated, and any remaining risks

If reviewer feedback conflicts with prior invariants or the task brief, stop and mark the work blocked instead of improvising.

## Review-gate rules

No increment is complete until the reviewer marks it approved.

Valid review outcomes:

- `approved`
- `changes_requested`
- `blocked`

If the reviewer requests changes:

- apply only those fixes needed for the current increment
- do not silently broaden scope
- re-run the minimum relevant validation

## Validation policy

Choose validation based on the task type.

### Business logic / backend changes

Prefer:

- unit tests
- integration tests when available
- type checking / linting when already configured

### API-related changes

Prefer:

- unit or integration tests
- API smoke tests (`curl`, repo scripts, or existing API test commands)
- log inspection for local server responses when relevant

### UI-related changes

Prefer:

- browser-driven checks when the repo already supports them
- screenshot comparison when practical
- console log inspection for runtime errors
- accessibility checks if the task touches interaction, semantics, or form behavior

For UI tasks, a strong default is:

1. capture a before-state screenshot when useful
2. implement the increment
3. capture an after-state screenshot
4. compare against the task brief or expected behavior
5. explain any mismatch before declaring success

### Console and runtime observation

If a local app or test server is started, inspect:

- build output
- browser console errors
- server logs
- failing test output

Do not claim success while obvious runtime errors remain unresolved.

## Tooling expectations

Use existing repo tools first.

Examples:

- package scripts from `package.json`
- existing test runners
- Playwright / Cypress if already present
- Storybook if already present
- repo-local lint / typecheck commands

Do not add large new toolchains just to satisfy validation unless the task explicitly asks for it.

## Git behavior

Preferred pattern:

- one branch per increment during autonomous execution
- small commits
- descriptive commit messages

Do not merge without an explicit approved review result.

## Communication style

Handoffs must be factual and concise.

Implementation handoffs should include:

- increment id
- summary of changes
- files changed
- tests run and outcomes
- risks
- open questions

Never hide uncertainty.
