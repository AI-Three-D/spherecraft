# Local Codex + Claude Orchestrator

This is a repo-local, task-folder-based orchestration setup for a two-agent workflow:

- **Codex** implements.
- **Claude Code** reviews and guards architecture.
- **`orchestrate.py`** handles turn-taking and state.

The design goal is to remain usable across changing Codex and Claude CLI versions by depending on **simple prompt contracts and local JSON extraction**, rather than one exact event stream format.

## Files

- `orchestrate.py` — the orchestrator
- `AGENTS.md` — repo policy for implementer-side behavior
- `CLAUDE.md` — repo policy for reviewer-side behavior

Per task, the orchestrator creates:

```text
tasks/<task-slug>/
```

with files such as:

- `task.md`
- `refined-task.md`
- `plan.json`
- `plan-review.json`
- `current-increment.json`
- `codex-handoff.json`
- `claude-review.json`
- `state.json`
- `run.log`

## Requirements

- Python 3.10+
- `codex` CLI installed and authenticated
- `claude` CLI installed and authenticated
- git repository

## Main idea

The script uses four phases:

1. **refine** — tighten the raw task and decide whether clarification is needed
2. **plan** — have Codex propose staged increments
3. **review-plan** — have Claude approve or correct the plan
4. **run** — implement and review one increment at a time until done or blocked

The script stores task state on disk so the run is inspectable and resumable.

## Quick start

From the repo root, copy these files in place and then run:

```bash
python orchestrate.py prep-and-run --task "Add team-based permissions to project access"
```

To stop after a single increment:

```bash
python orchestrate.py prep-and-run \
  --task "Add team-based permissions to project access" \
  --one-increment
```

To continue a task later:

```bash
python orchestrate.py run --task-slug add-team-based-permissions-to-project-access
```

## Recommended first run

Start conservatively:

```bash
python orchestrate.py prep-and-run \
  --task "Your feature request here" \
  --one-increment
```

Then inspect:

- `tasks/<task-slug>/state.json`
- `tasks/<task-slug>/run.log`
- `tasks/<task-slug>/plan.json`
- `tasks/<task-slug>/claude-review.json`

Once the loop behaves the way you want, you can let it run for longer.

## Commands

### Initialize a task

```bash
python orchestrate.py init --task "Build feature X"
```

### Refine the task first

```bash
python orchestrate.py refine --task-slug build-feature-x --planner claude
```

Planner can be `claude` or `codex`.

### Build a plan

```bash
python orchestrate.py plan --task-slug build-feature-x
```

### Review the plan

```bash
python orchestrate.py review-plan --task-slug build-feature-x
```

### Run the increment loop

```bash
python orchestrate.py run --task-slug build-feature-x
```

Helpful flags:

- `--one-increment`
- `--max-review-cycles 2`
- `--git-auto-commit`
- `--git-auto-merge`
- `--codex-model <model>`
- `--claude-model <model>`

### Show status

```bash
python orchestrate.py status --task-slug build-feature-x
```

## Git behavior

By default the script does **not** auto-commit or auto-merge.

That is intentional.

For safer early testing, leave merge control in your hands. Once you trust the loop, you can enable:

```bash
python orchestrate.py run \
  --task-slug build-feature-x \
  --git-auto-commit
```

and later, if you really want:

```bash
python orchestrate.py run \
  --task-slug build-feature-x \
  --git-auto-commit \
  --git-auto-merge
```

## Why this is version-tolerant

The script does **not** rely on one exact Codex JSONL event schema or one exact Claude headless output schema.

Instead it asks both models to return a plain JSON object wrapped in sentinels:

```text
<<<JSON_START>>>
{ ... }
<<<JSON_END>>>
```

The script then extracts and validates that JSON locally.

This is much more stable across CLI releases than hard-coding one event format.

## UI and testing notes

The policy files already encourage choosing validation based on the task type:

- logic/backend: unit and integration tests
- API work: tests plus smoke checks
- UI work: browser/screenshot checks, console inspection, and accessibility where relevant

This repo package does **not** hard-wire Playwright or screenshot commands yet. It leaves that to existing repo tooling and to the instructions in `AGENTS.md` / `CLAUDE.md`.

## Practical workflow in VS Code

A simple way to use this from VS Code:

1. Open the repo.
2. Put these files at the repo root.
3. Ask your visible Codex or Claude session to use the repo orchestrator.
4. Example natural prompt:

> I have this task for you: ... Read `AGENTS.md` and `CLAUDE.md`, create a task folder, run the repo orchestrator, and only ask me clarifying questions if the task is not ready for unattended execution.

That way you do not have to type the full command chain every time.

## Suggested next upgrades

Once this base works in your repo, the highest-value upgrades are:

- repo-specific test command detection
- Playwright / screenshot hooks for frontend tasks
- desktop notifications on blocked or completed states
- a VS Code `tasks.json` or extension wrapper

## Caveats

- CLI flags and output formats can still change over time.
- The script is resilient, not magic: if a future CLI version changes invocation semantics substantially, you may still need a small adapter tweak.
- For long unattended runs, start with small features and conservative git settings first.
