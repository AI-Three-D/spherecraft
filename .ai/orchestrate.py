#!/usr/bin/env python3
"""
Repo-local orchestrator for Codex <-> Claude Code collaboration.

Design goals:
- Standard-library only.
- Durable task state under tasks/<slug>/.
- Resilient across CLI version changes by preferring plain-text contracts
  with strict local JSON extraction / validation.
- Native JSON / structured-output flags are optional accelerators, not hard dependencies.

This script assumes:
- `codex` CLI is installed and authenticated.
- `claude` CLI is installed and authenticated.
- You are running from the repository root.

Typical flow:
  python orchestrate.py prep-and-run --task "Build feature X"

Or stepwise:
  python orchestrate.py init --task "Build feature X"
  python orchestrate.py refine --task-slug build-feature-x --planner claude
  python orchestrate.py plan --task-slug build-feature-x
  python orchestrate.py review-plan --task-slug build-feature-x
  python orchestrate.py run --task-slug build-feature-x
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path.cwd()
TASKS_DIR = ROOT / "tasks"
STATE_FILE = "state.json"
TASK_FILE = "task.md"
REFINED_TASK_FILE = "refined-task.md"
PLAN_FILE = "plan.json"
PLAN_REVIEW_FILE = "plan-review.json"
CURRENT_INCREMENT_FILE = "current-increment.json"
CODEX_HANDOFF_FILE = "codex-handoff.json"
CLAUDE_REVIEW_FILE = "claude-review.json"
RUN_LOG_FILE = "run.log"

DEFAULT_MAX_REVIEW_CYCLES = 2

JSON_SENTINEL_OPEN = "<<<JSON_START>>>"
JSON_SENTINEL_CLOSE = "<<<JSON_END>>>"


class OrchestratorError(RuntimeError):
    pass


# ---------- small utilities ----------

def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")



def slugify(text: str, max_len: int = 48) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"^-+|-+$", "", text)
    return (text[:max_len].rstrip("-")) or "task"



def read_text(path: Path, default: str = "") -> str:
    return path.read_text(encoding="utf-8") if path.exists() else default



def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")



def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))



def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")



def append_log(task_dir: Path, line: str) -> None:
    ts = now_iso()
    with (task_dir / RUN_LOG_FILE).open("a", encoding="utf-8") as f:
        f.write(f"[{ts}] {line}\n")



def ensure_tasks_dir() -> None:
    TASKS_DIR.mkdir(parents=True, exist_ok=True)



def task_dir_for_slug(slug: str) -> Path:
    return TASKS_DIR / slug



def require_cmd(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise OrchestratorError(f"Required command not found on PATH: {name}")
    return found



def repo_relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)



def current_git_branch() -> str:
    try:
        cp = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return cp.stdout.strip()
    except Exception:
        return "unknown"



def git_status_short() -> str:
    try:
        cp = subprocess.run(
            ["git", "status", "--short"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return cp.stdout.strip()
    except Exception:
        return ""



def git_diff_stat() -> str:
    try:
        cp = subprocess.run(
            ["git", "diff", "--stat"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return cp.stdout.strip()
    except Exception:
        return ""



def git_diff_unified() -> str:
    try:
        cp = subprocess.run(
            ["git", "diff", "--no-ext-diff", "--unified=3"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return cp.stdout.strip()
    except Exception:
        return ""



def git_checkout_new_branch(name: str) -> None:
    subprocess.run(["git", "checkout", "-b", name], cwd=ROOT, check=True)



def git_commit_all(message: str) -> bool:
    status = git_status_short()
    if not status:
        return False
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-m", message], cwd=ROOT, check=True)
    return True



def git_merge_no_ff(branch: str, target_branch: Optional[str] = None) -> None:
    if target_branch:
        subprocess.run(["git", "checkout", target_branch], cwd=ROOT, check=True)
    subprocess.run(["git", "merge", "--no-ff", branch], cwd=ROOT, check=True)



def extract_json_block(text: str) -> Dict[str, Any]:
    """Extract the most plausible JSON object from text.

    Strategy:
    1. Prefer sentinel block.
    2. Fallback to largest {...} object.
    """
    m = re.search(re.escape(JSON_SENTINEL_OPEN) + r"\s*(\{.*?\})\s*" + re.escape(JSON_SENTINEL_CLOSE), text, re.S)
    if m:
        return json.loads(m.group(1))

    candidates: List[str] = []
    for match in re.finditer(r"\{", text):
        start = match.start()
        depth = 0
        for i in range(start, len(text)):
            ch = text[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start : i + 1])
                    break
    candidates = sorted(candidates, key=len, reverse=True)
    for cand in candidates:
        try:
            return json.loads(cand)
        except Exception:
            continue
    raise OrchestratorError("Could not extract valid JSON from model output")



def validate_required(obj: Dict[str, Any], required: List[str], name: str) -> None:
    missing = [k for k in required if k not in obj]
    if missing:
        raise OrchestratorError(f"{name} missing required keys: {missing}")


# ---------- prompt contracts ----------

def json_contract(schema_hint: str) -> str:
    return textwrap.dedent(
        f"""
        Return a single JSON object only.
        Wrap it exactly like this:
        {JSON_SENTINEL_OPEN}
        {{...json...}}
        {JSON_SENTINEL_CLOSE}

        JSON contract:
        {schema_hint}
        """
    ).strip()



def load_policy_files() -> str:
    agents = read_text(ROOT / "AGENTS.md")
    claude = read_text(ROOT / "CLAUDE.md")
    pieces = []
    if agents:
        pieces.append("[AGENTS.md]\n" + agents)
    if claude:
        pieces.append("[CLAUDE.md]\n" + claude)
    return "\n\n".join(pieces).strip()



def build_refine_prompt(task_dir: Path) -> str:
    raw_task = read_text(task_dir / TASK_FILE)
    policy = load_policy_files()
    schema = """
{
  "decision": "ready|needs_clarification",
  "task_slug": "string",
  "title": "string",
  "summary": "string",
  "assumptions": ["string"],
  "questions": ["string"],
  "recommended_validation": ["unit_tests|integration_tests|api_smoke|browser_screenshot|console_logs|accessibility|manual_only"],
  "refined_task_markdown": "string"
}
""".strip()
    return textwrap.dedent(
        f"""
        You are the task intake and viability analyst for a repository-local autonomous coding workflow.

        Your job:
        1. Read the raw task.
        2. Decide whether it is specific enough for an unattended implementation run.
        3. Tighten it into a concise refined task brief.
        4. Recommend validation modes based on the task and likely repo shape.
        5. Ask only the minimum clarifying questions if needed.

        Repository policy:
        {policy or '[No AGENTS.md / CLAUDE.md found]'}

        Raw task:
        {raw_task}

        {json_contract(schema)}
        """
    ).strip()



def build_plan_prompt(task_dir: Path) -> str:
    refined = read_text(task_dir / REFINED_TASK_FILE)
    schema = """
{
  "title": "string",
  "summary": "string",
  "invariants": ["string"],
  "increments": [
    {
      "id": "01-short-id",
      "title": "string",
      "goal": "string",
      "scope": ["string"],
      "validation": ["string"],
      "done_when": ["string"]
    }
  ]
}
""".strip()
    return textwrap.dedent(
        f"""
        You are the implementer planning a staged implementation.
        Produce a small-step plan for the task below.

        Requirements:
        - Keep increments narrowly scoped and reviewable.
        - Order increments to minimize architectural risk.
        - Include invariants that future increments must preserve.
        - Do not implement code. Planning only.

        Refined task:
        {refined}

        {json_contract(schema)}
        """
    ).strip()



def build_review_plan_prompt(task_dir: Path) -> str:
    refined = read_text(task_dir / REFINED_TASK_FILE)
    plan = read_text(task_dir / PLAN_FILE)
    schema = """
{
  "decision": "approved|changes_requested|blocked",
  "summary": "string",
  "must_fix": ["string"],
  "optional_improvements": ["string"],
  "invariants": ["string"],
  "plan_patch": {
    "replace_increments": false,
    "increments": []
  }
}
""".strip()
    return textwrap.dedent(
        f"""
        You are the reviewer/architect.
        Review the staged plan for correctness, sequencing, and architectural safety.
        Prefer preserving the existing plan unless changes are actually needed.

        Refined task:
        {refined}

        Proposed plan JSON:
        {plan}

        {json_contract(schema)}
        """
    ).strip()



def build_implement_prompt(task_dir: Path, increment: Dict[str, Any], review_cycle: int) -> str:
    refined = read_text(task_dir / REFINED_TASK_FILE)
    plan = read_json(task_dir / PLAN_FILE, {})
    plan_review = read_json(task_dir / PLAN_REVIEW_FILE, {})
    last_review = read_json(task_dir / CLAUDE_REVIEW_FILE, {})
    schema = """
{
  "status": "implemented|blocked|needs_clarification",
  "increment_id": "string",
  "summary": "string",
  "files_changed": ["string"],
  "tests_run": [{"command": "string", "result": "pass|fail|not_run", "notes": "string"}],
  "risks": ["string"],
  "questions": ["string"],
  "commit_message": "string",
  "suggested_branch": "string",
  "deliverable_notes": "string"
}
""".strip()
    return textwrap.dedent(
        f"""
        You are the implementer agent.

        Implement ONLY the current increment below.
        Do not begin future increments.
        If prior reviewer feedback exists, apply must-fix items relevant to this increment.

        Current repository branch: {current_git_branch()}
        Current git status:
        {git_status_short() or '[clean]'}

        Refined task:
        {refined}

        Plan summary JSON:
        {json.dumps(plan, ensure_ascii=False, indent=2)}

        Plan review JSON:
        {json.dumps(plan_review, ensure_ascii=False, indent=2)}

        Current increment JSON:
        {json.dumps(increment, ensure_ascii=False, indent=2)}

        Current review cycle: {review_cycle}
        Previous increment review JSON:
        {json.dumps(last_review, ensure_ascii=False, indent=2)}

        Before you stop:
        - Make the code changes in the repo.
        - Run the minimum relevant validation for this increment.
        - Prepare a factual handoff summary.

        {json_contract(schema)}
        """
    ).strip()



def build_increment_review_prompt(task_dir: Path, increment: Dict[str, Any], handoff: Dict[str, Any]) -> str:
    refined = read_text(task_dir / REFINED_TASK_FILE)
    plan = read_json(task_dir / PLAN_FILE, {})
    diff_stat = git_diff_stat()
    diff = git_diff_unified()
    if len(diff) > 120_000:
        diff = diff[:120_000] + "\n\n[TRUNCATED]"
    schema = """
{
  "decision": "approved|changes_requested|blocked",
  "summary": "string",
  "must_fix": ["string"],
  "optional_improvements": ["string"],
  "risk_flags": ["string"],
  "next_increment_constraints": ["string"]
}
""".strip()
    return textwrap.dedent(
        f"""
        You are the reviewer and architect.
        Review ONLY the current increment and the current repository diff.

        Refined task:
        {refined}

        Plan JSON:
        {json.dumps(plan, ensure_ascii=False, indent=2)}

        Current increment JSON:
        {json.dumps(increment, ensure_ascii=False, indent=2)}

        Implementer handoff JSON:
        {json.dumps(handoff, ensure_ascii=False, indent=2)}

        Git diff --stat:
        {diff_stat or '[empty diff stat]'}

        Unified diff:
        {diff or '[no diff]'}

        Decision rules:
        - APPROVED only if the increment goal is met and no must-fix issue remains.
        - CHANGES_REQUESTED if fixes are specific and local.
        - BLOCKED if architecture or scope is fundamentally wrong.

        {json_contract(schema)}
        """
    ).strip()


# ---------- CLI adapters ----------

def run_subprocess(cmd: List[str], stdin_text: Optional[str] = None, cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd or ROOT,
        input=stdin_text,
        text=True,
        capture_output=True,
    )



def codex_invoke(prompt: str, session_id: Optional[str] = None, model: Optional[str] = None) -> Tuple[Dict[str, Any], Optional[str], str]:
    require_cmd("codex")

    # Prefer durable plain-text contract. Native flags vary by version.
    cmd = ["codex", "exec"]
    if session_id:
        # Try resume style first if available in installed version.
        cmd += ["resume", session_id]
    if model:
        cmd += ["--model", model]

    cp = run_subprocess(cmd, stdin_text=prompt + "\n")
    combined = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise OrchestratorError(f"Codex command failed ({cp.returncode})\n{combined}")

    data = extract_json_block(combined)
    resumed_session = extract_session_id(combined, preferred=session_id)
    return data, resumed_session, combined



def claude_invoke(prompt: str, session_id: Optional[str] = None, model: Optional[str] = None) -> Tuple[Dict[str, Any], Optional[str], str]:
    require_cmd("claude")

    # Headless prompt mode. Prefer a plain response contract; structured output flags differ by version.
    cmd = ["claude", "-p"]
    if session_id:
        cmd += ["--resume", session_id]
    if model:
        cmd += ["--model", model]

    cp = run_subprocess(cmd, stdin_text=prompt + "\n")
    combined = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise OrchestratorError(f"Claude command failed ({cp.returncode})\n{combined}")

    data = extract_json_block(combined)
    resumed_session = extract_session_id(combined, preferred=session_id)
    return data, resumed_session, combined



def extract_session_id(text: str, preferred: Optional[str] = None) -> Optional[str]:
    # Gracefully parse a few plausible formats without depending on one exact version.
    patterns = [
        r"session[_ -]?id['\"]?\s*[:=]\s*['\"]([A-Za-z0-9._:-]+)['\"]",
        r"resum(?:e|ed)\s+session\s+([A-Za-z0-9._:-]+)",
        r"--resume\s+([A-Za-z0-9._:-]+)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            return m.group(1)
    return preferred


# ---------- task model ----------

def load_state(task_dir: Path) -> Dict[str, Any]:
    return read_json(task_dir / STATE_FILE, default={}) or {}



def save_state(task_dir: Path, **patch: Any) -> Dict[str, Any]:
    state = load_state(task_dir)
    state.update(patch)
    state["updated_at"] = now_iso()
    write_json(task_dir / STATE_FILE, state)
    return state



def infer_task_slug(task_text: str) -> str:
    title = task_text.strip().splitlines()[0]
    title = re.sub(r"^#+\s*", "", title)
    return slugify(title)



def init_task(raw_task: str, slug: Optional[str] = None) -> Path:
    ensure_tasks_dir()
    actual_slug = slug or infer_task_slug(raw_task)
    task_dir = task_dir_for_slug(actual_slug)
    task_dir.mkdir(parents=True, exist_ok=True)
    write_text(task_dir / TASK_FILE, raw_task.strip() + "\n")
    if not (task_dir / REFINED_TASK_FILE).exists():
        write_text(task_dir / REFINED_TASK_FILE, "")
    save_state(
        task_dir,
        task_slug=actual_slug,
        created_at=now_iso(),
        phase="initialized",
        codex_session_id=None,
        claude_session_id=None,
        current_increment_index=0,
        review_cycle=0,
        run_status="idle",
        git_base_branch=current_git_branch(),
    )
    append_log(task_dir, f"Initialized task '{actual_slug}'")
    return task_dir



def refine_task(task_dir: Path, planner: str = "claude", model: Optional[str] = None) -> Dict[str, Any]:
    prompt = build_refine_prompt(task_dir)
    state = load_state(task_dir)
    if planner == "claude":
        result, session_id, _ = claude_invoke(prompt, session_id=state.get("claude_session_id"), model=model)
        save_state(task_dir, claude_session_id=session_id, phase="refined")
    else:
        result, session_id, _ = codex_invoke(prompt, session_id=state.get("codex_session_id"), model=model)
        save_state(task_dir, codex_session_id=session_id, phase="refined")

    validate_required(result, ["decision", "title", "summary", "questions", "recommended_validation", "refined_task_markdown"], "refine result")
    write_text(task_dir / REFINED_TASK_FILE, result["refined_task_markdown"].strip() + "\n")
    write_json(task_dir / "refine.json", result)
    append_log(task_dir, f"Refined task; decision={result['decision']}")
    return result



def plan_task(task_dir: Path, model: Optional[str] = None) -> Dict[str, Any]:
    prompt = build_plan_prompt(task_dir)
    state = load_state(task_dir)
    result, session_id, _ = codex_invoke(prompt, session_id=state.get("codex_session_id"), model=model)
    validate_required(result, ["title", "summary", "invariants", "increments"], "plan")
    if not isinstance(result.get("increments"), list) or not result["increments"]:
        raise OrchestratorError("Plan must contain at least one increment")
    write_json(task_dir / PLAN_FILE, result)
    save_state(task_dir, codex_session_id=session_id, phase="planned")
    append_log(task_dir, f"Planned {len(result['increments'])} increments")
    return result



def review_plan(task_dir: Path, model: Optional[str] = None) -> Dict[str, Any]:
    prompt = build_review_plan_prompt(task_dir)
    state = load_state(task_dir)
    result, session_id, _ = claude_invoke(prompt, session_id=state.get("claude_session_id"), model=model)
    validate_required(result, ["decision", "summary", "must_fix", "optional_improvements", "invariants", "plan_patch"], "plan review")
    write_json(task_dir / PLAN_REVIEW_FILE, result)

    if result.get("decision") == "approved":
        save_state(task_dir, claude_session_id=session_id, phase="plan_approved")
    else:
        save_state(task_dir, claude_session_id=session_id, phase="plan_reviewed")

    # Optional patch application when explicitly requested.
    patch = result.get("plan_patch") or {}
    if patch.get("replace_increments"):
        plan = read_json(task_dir / PLAN_FILE, default={}) or {}
        if patch.get("increments"):
            plan["increments"] = patch["increments"]
            write_json(task_dir / PLAN_FILE, plan)
            append_log(task_dir, "Applied reviewer-provided increment patch to plan")

    append_log(task_dir, f"Reviewed plan; decision={result['decision']}")
    return result



def get_current_increment(task_dir: Path) -> Dict[str, Any]:
    state = load_state(task_dir)
    plan = read_json(task_dir / PLAN_FILE, default={}) or {}
    increments = plan.get("increments") or []
    idx = int(state.get("current_increment_index", 0))
    if idx >= len(increments):
        raise OrchestratorError("No remaining increments")
    return increments[idx]



def begin_increment_branch(task_dir: Path, increment: Dict[str, Any]) -> str:
    state = load_state(task_dir)
    if state.get("active_branch"):
        return state["active_branch"]
    idx = int(state.get("current_increment_index", 0)) + 1
    branch = f"ai/{state['task_slug']}/{idx:02d}-{slugify(increment.get('title', increment.get('id', 'step')))}"
    git_checkout_new_branch(branch)
    save_state(task_dir, active_branch=branch)
    append_log(task_dir, f"Checked out increment branch {branch}")
    return branch



def implement_increment(task_dir: Path, model: Optional[str] = None) -> Dict[str, Any]:
    increment = get_current_increment(task_dir)
    state = load_state(task_dir)
    review_cycle = int(state.get("review_cycle", 0))
    branch = begin_increment_branch(task_dir, increment)

    prompt = build_implement_prompt(task_dir, increment, review_cycle)
    result, session_id, _ = codex_invoke(prompt, session_id=state.get("codex_session_id"), model=model)
    validate_required(result, ["status", "increment_id", "summary", "files_changed", "tests_run", "risks", "questions", "commit_message", "suggested_branch", "deliverable_notes"], "implement handoff")

    result["branch"] = branch
    write_json(task_dir / CURRENT_INCREMENT_FILE, increment)
    write_json(task_dir / CODEX_HANDOFF_FILE, result)
    save_state(task_dir, codex_session_id=session_id, phase="increment_implemented")
    append_log(task_dir, f"Implemented increment {increment.get('id')} status={result['status']}")
    return result



def review_increment(task_dir: Path, model: Optional[str] = None) -> Dict[str, Any]:
    increment = read_json(task_dir / CURRENT_INCREMENT_FILE, default={}) or get_current_increment(task_dir)
    handoff = read_json(task_dir / CODEX_HANDOFF_FILE, default={}) or {}
    prompt = build_increment_review_prompt(task_dir, increment, handoff)
    state = load_state(task_dir)
    result, session_id, _ = claude_invoke(prompt, session_id=state.get("claude_session_id"), model=model)
    validate_required(result, ["decision", "summary", "must_fix", "optional_improvements", "risk_flags", "next_increment_constraints"], "increment review")
    write_json(task_dir / CLAUDE_REVIEW_FILE, result)
    save_state(task_dir, claude_session_id=session_id, phase="increment_reviewed")
    append_log(task_dir, f"Reviewed increment {increment.get('id')} decision={result['decision']}")
    return result



def approve_increment(task_dir: Path, git_auto_commit: bool = True, git_auto_merge: bool = False) -> None:
    state = load_state(task_dir)
    increment = read_json(task_dir / CURRENT_INCREMENT_FILE, default={}) or {}
    handoff = read_json(task_dir / CODEX_HANDOFF_FILE, default={}) or {}
    branch = state.get("active_branch")
    base = state.get("git_base_branch") or "main"

    committed = False
    if git_auto_commit:
        msg = handoff.get("commit_message") or f"Complete increment {increment.get('id', 'step')}"
        committed = git_commit_all(msg)
        append_log(task_dir, f"Commit {'created' if committed else 'skipped (clean tree)'}")

    if git_auto_merge and branch:
        git_merge_no_ff(branch, target_branch=base)
        append_log(task_dir, f"Merged {branch} into {base}")

    idx = int(state.get("current_increment_index", 0)) + 1
    save_state(
        task_dir,
        current_increment_index=idx,
        review_cycle=0,
        active_branch=None,
        phase="increment_approved",
    )



def run_loop(
    task_dir: Path,
    max_review_cycles: int = DEFAULT_MAX_REVIEW_CYCLES,
    one_increment: bool = False,
    codex_model: Optional[str] = None,
    claude_model: Optional[str] = None,
    git_auto_commit: bool = True,
    git_auto_merge: bool = False,
) -> None:
    state = load_state(task_dir)
    plan = read_json(task_dir / PLAN_FILE, default={}) or {}
    increments = plan.get("increments") or []
    if not increments:
        raise OrchestratorError("No plan increments found. Run plan first.")

    save_state(task_dir, run_status="running")
    while True:
        state = load_state(task_dir)
        idx = int(state.get("current_increment_index", 0))
        if idx >= len(increments):
            save_state(task_dir, run_status="complete", phase="done")
            append_log(task_dir, "Run complete")
            return

        increment = increments[idx]
        append_log(task_dir, f"Starting increment {increment.get('id')}")

        implement_increment(task_dir, model=codex_model)
        review = review_increment(task_dir, model=claude_model)

        while review["decision"] == "changes_requested":
            state = load_state(task_dir)
            cycle = int(state.get("review_cycle", 0)) + 1
            save_state(task_dir, review_cycle=cycle)
            if cycle > max_review_cycles:
                save_state(task_dir, run_status="blocked", phase="max_review_cycles_exceeded")
                append_log(task_dir, "Stopped: max review cycles exceeded")
                return
            append_log(task_dir, f"Applying requested changes for increment {increment.get('id')} cycle={cycle}")
            implement_increment(task_dir, model=codex_model)
            review = review_increment(task_dir, model=claude_model)

        if review["decision"] == "blocked":
            save_state(task_dir, run_status="blocked", phase="blocked_by_review")
            append_log(task_dir, f"Blocked on increment {increment.get('id')}")
            return

        approve_increment(task_dir, git_auto_commit=git_auto_commit, git_auto_merge=git_auto_merge)
        append_log(task_dir, f"Approved increment {increment.get('id')}")

        if one_increment:
            save_state(task_dir, run_status="paused", phase="one_increment_done")
            append_log(task_dir, "Paused after one increment by request")
            return



def prep_and_run(
    raw_task: str,
    slug: Optional[str],
    planner: str,
    codex_model: Optional[str],
    claude_model: Optional[str],
    one_increment: bool,
    git_auto_commit: bool,
    git_auto_merge: bool,
) -> Path:
    task_dir = init_task(raw_task, slug)
    refine = refine_task(task_dir, planner=planner, model=claude_model if planner == "claude" else codex_model)
    if refine.get("decision") == "needs_clarification":
        save_state(task_dir, run_status="needs_clarification", phase="awaiting_user")
        append_log(task_dir, "Stopping after refine: clarification required")
        return task_dir
    plan_task(task_dir, model=codex_model)
    plan_review = review_plan(task_dir, model=claude_model)
    if plan_review.get("decision") != "approved":
        save_state(task_dir, run_status="needs_attention", phase="plan_not_approved")
        append_log(task_dir, f"Stopping after plan review: {plan_review.get('decision')}")
        return task_dir
    run_loop(
        task_dir,
        one_increment=one_increment,
        codex_model=codex_model,
        claude_model=claude_model,
        git_auto_commit=git_auto_commit,
        git_auto_merge=git_auto_merge,
    )
    return task_dir


# ---------- cli ----------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Repo-local Codex <-> Claude orchestrator")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common_models(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--codex-model", default=None)
        sp.add_argument("--claude-model", default=None)

    sp = sub.add_parser("init", help="Create task folder and save raw task")
    sp.add_argument("--task", required=True)
    sp.add_argument("--task-slug", default=None)

    sp = sub.add_parser("refine", help="Run viability analysis and refine task")
    sp.add_argument("--task-slug", required=True)
    sp.add_argument("--planner", choices=["claude", "codex"], default="claude")
    add_common_models(sp)

    sp = sub.add_parser("plan", help="Create staged implementation plan with Codex")
    sp.add_argument("--task-slug", required=True)
    add_common_models(sp)

    sp = sub.add_parser("review-plan", help="Review plan with Claude")
    sp.add_argument("--task-slug", required=True)
    add_common_models(sp)

    sp = sub.add_parser("run", help="Run increment loop")
    sp.add_argument("--task-slug", required=True)
    sp.add_argument("--one-increment", action="store_true")
    sp.add_argument("--max-review-cycles", type=int, default=DEFAULT_MAX_REVIEW_CYCLES)
    sp.add_argument("--git-auto-commit", action="store_true", default=False)
    sp.add_argument("--git-auto-merge", action="store_true", default=False)
    add_common_models(sp)

    sp = sub.add_parser("prep-and-run", help="Initialize, refine, plan, review, and run")
    sp.add_argument("--task", required=True)
    sp.add_argument("--task-slug", default=None)
    sp.add_argument("--planner", choices=["claude", "codex"], default="claude")
    sp.add_argument("--one-increment", action="store_true")
    sp.add_argument("--git-auto-commit", action="store_true", default=False)
    sp.add_argument("--git-auto-merge", action="store_true", default=False)
    add_common_models(sp)

    sp = sub.add_parser("status", help="Show task status")
    sp.add_argument("--task-slug", required=True)

    return p.parse_args()



def print_status(task_dir: Path) -> None:
    state = load_state(task_dir)
    print(json.dumps(state, indent=2, ensure_ascii=False))
    print()
    for name in [TASK_FILE, REFINED_TASK_FILE, PLAN_FILE, PLAN_REVIEW_FILE, CURRENT_INCREMENT_FILE, CODEX_HANDOFF_FILE, CLAUDE_REVIEW_FILE]:
        path = task_dir / name
        if path.exists():
            print(f"- {repo_relative(path)}")



def main() -> int:
    args = parse_args()
    try:
        if args.cmd == "init":
            task_dir = init_task(args.task, args.task_slug)
            print(f"Initialized {repo_relative(task_dir)}")
            return 0

        if args.cmd == "refine":
            task_dir = task_dir_for_slug(args.task_slug)
            result = refine_task(task_dir, planner=args.planner, model=args.claude_model if args.planner == "claude" else args.codex_model)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0

        if args.cmd == "plan":
            task_dir = task_dir_for_slug(args.task_slug)
            result = plan_task(task_dir, model=args.codex_model)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0

        if args.cmd == "review-plan":
            task_dir = task_dir_for_slug(args.task_slug)
            result = review_plan(task_dir, model=args.claude_model)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0

        if args.cmd == "run":
            task_dir = task_dir_for_slug(args.task_slug)
            run_loop(
                task_dir,
                max_review_cycles=args.max_review_cycles,
                one_increment=args.one_increment,
                codex_model=args.codex_model,
                claude_model=args.claude_model,
                git_auto_commit=args.git_auto_commit,
                git_auto_merge=args.git_auto_merge,
            )
            print_status(task_dir)
            return 0

        if args.cmd == "prep-and-run":
            task_dir = prep_and_run(
                raw_task=args.task,
                slug=args.task_slug,
                planner=args.planner,
                codex_model=args.codex_model,
                claude_model=args.claude_model,
                one_increment=args.one_increment,
                git_auto_commit=args.git_auto_commit,
                git_auto_merge=args.git_auto_merge,
            )
            print_status(task_dir)
            return 0

        if args.cmd == "status":
            task_dir = task_dir_for_slug(args.task_slug)
            print_status(task_dir)
            return 0

        raise OrchestratorError(f"Unknown command: {args.cmd}")
    except OrchestratorError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {e}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
