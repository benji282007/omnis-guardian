#!/usr/bin/env python3
"""Offline validation of the Duo flow definition and .gitlab-ci.yml structure.

This catches mistakes before they reach GitLab. It is not a substitute for
GitLab's own validation: the flow is validated again when it is created in
AI > Flows, and the pipeline config by GitLab's CI linter.

Usage: python3 scripts/ci/validate_config.py [repo_root]
"""
import re
import sys
from pathlib import Path

import yaml

# Tools documented for agents/flows in the GitLab Web UI
# (docs.gitlab.com/user/duo_agent_platform/agents/tools/, checked 2026-10-24).
WEB_TOOLS = {
    "add_merge_request_reviewers", "create_merge_request", "create_merge_request_diff_note",
    "create_merge_request_note", "get_merge_request", "gitlab_merge_request_search",
    "list_all_merge_request_notes", "list_merge_request_diffs", "list_mr_discussions",
    "reply_to_discussion", "set_discussion_resolved", "submit_mr_review", "update_merge_request",
    "build_review_merge_request_context", "link_vulnerability_to_merge_request",
    "create_issue", "get_issue", "list_issues", "update_issue", "gitlab_issue_search",
    "create_issue_note", "get_issue_note", "list_issue_notes", "create_work_item",
    "get_work_item", "update_work_item", "list_work_items", "create_work_item_note",
    "get_work_item_notes", "get_project", "gitlab_note_search",
    "create_branch", "create_commit", "get_commit", "get_commit_diff", "get_commit_comments",
    "list_commits", "gitlab_commit_search", "get_repository_file", "get_repository_files",
    "list_repository_tree", "gitlab_blob_search",
    "ci_linter", "run_tests", "get_job_logs", "get_pipeline_errors", "get_pipeline_failing_jobs",
    "get_failing_bridge_jobs", "get_downstream_pipelines",
    "list_vulnerabilities", "get_vulnerability_details", "list_security_findings",
    "get_security_finding_details", "gitlab_api_get", "gitlab_graphql",
    "gitlab_documentation_search", "get_current_user", "extract_lines_from_text",
}
IDE_ONLY_TOOLS = {
    "read_file", "read_files", "create_file_with_contents", "edit_file", "list_dir",
    "find_files", "grep", "mkdir", "run_command", "notify_me_when",
}
COMPONENT_TYPES = {"AgentComponent", "OneOffComponent", "DeterministicStepComponent", "HumanInputComponent"}
FORBIDDEN_TOP_LEVEL = {"name", "description", "product_group"}  # rejected for custom flows


def validate_flow(path: Path) -> list[str]:
    errors: list[str] = []
    flow = yaml.safe_load(path.read_text())
    err = errors.append

    if flow.get("version") != "v1":
        err("version must be \"v1\"")
    if flow.get("environment") != "ambient":
        err("custom flows only support environment: ambient")
    for key in FORBIDDEN_TOP_LEVEL & flow.keys():
        err(f"top-level '{key}' is rejected for custom flows")

    prompts = {p.get("prompt_id"): p for p in flow.get("prompts", [])}
    for pid, p in prompts.items():
        if "model" in p:
            err(f"prompt {pid}: 'model' is not supported in custom flows")
        tmpl = p.get("prompt_template", {})
        if "system" not in tmpl or "user" not in tmpl:
            err(f"prompt {pid}: prompt_template needs system and user")
        if tmpl.get("placeholder") != "history":
            err(f"prompt {pid}: prompt_template.placeholder should be 'history'")
        if "unit_primitives" not in p:
            err(f"prompt {pid}: unit_primitives must be present")
        # GitLab rejects prompts containing HTML comments, tags, markdown link
        # comments or hidden unicode characters (SecurityException on create).
        for role, text in tmpl.items():
            if isinstance(text, str) and re.search(r"<!--|<[^>\n]*>|\[//\]:|\[comment\]:|[\u200b-\u200f\u2060\ufeff]", text):
                err(f"prompt {pid} ({role}): contains HTML comments, tags or hidden characters, which GitLab rejects")

    components = flow.get("components", [])
    names = [c.get("name") for c in components]
    if len(names) != len(set(names)):
        err("component names must be unique")
    for c in components:
        n = c.get("name", "?")
        if any(ch in n for ch in ":."):
            err(f"component {n}: names must not contain ':' or '.'")
        if c.get("type") not in COMPONENT_TYPES:
            err(f"component {n}: unknown type {c.get('type')}")
        if c.get("type") in {"AgentComponent", "OneOffComponent"}:
            if c.get("prompt_id") not in prompts:
                err(f"component {n}: prompt_id {c.get('prompt_id')} is not defined in prompts")
            for t in c.get("toolset", []):
                tool = next(iter(t)) if isinstance(t, dict) else t
                if tool in IDE_ONLY_TOOLS:
                    err(f"component {n}: tool '{tool}' is IDE-only; use an API tool instead")
                elif tool not in WEB_TOOLS:
                    err(f"component {n}: unknown tool '{tool}'")
        aliases = []
        for i in c.get("inputs", []):
            src = i.get("from", "") if isinstance(i, dict) else i
            if isinstance(i, dict) and not i.get("literal") and src.startswith("context:"):
                ref = src.split(":", 1)[1].split(".")[0]
                if ref not in {"goal", "project_id", "project_http_url_to_repo", "inputs"} and ref not in names:
                    err(f"component {n}: input {src} references unknown component {ref}")
            if isinstance(i, dict) and "as" in i:
                aliases.append(i["as"])
        if c.get("prompt_id") in prompts:
            user = prompts[c["prompt_id"]]["prompt_template"].get("user", "") + prompts[c["prompt_id"]]["prompt_template"].get("system", "")
            for a in aliases:
                if "{{ " + a + " }}" not in user:
                    err(f"component {n}: input alias '{a}' is never used in its prompt")

    entry = flow.get("flow", {}).get("entry_point")
    if entry not in names:
        err(f"flow.entry_point {entry} is not a component")
    targets = {"end", "abort", *names}
    edges: dict[str, set[str]] = {n: set() for n in names}
    for r in flow.get("routers", []):
        src = r.get("from")
        if src not in names:
            err(f"router from unknown component {src}")
            continue
        dests = [r["to"]] if "to" in r else list(r.get("condition", {}).get("routes", {}).values())
        for d in dests:
            if d not in targets:
                err(f"router {src} -> unknown target {d}")
            edges[src].add(d)
    # every component reachable from entry, and every path reaches end/abort
    seen, stack = set(), [entry]
    while stack:
        cur = stack.pop()
        if cur in seen or cur not in edges:
            continue
        seen.add(cur)
        stack.extend(edges[cur])
    for n in names:
        if n not in seen:
            err(f"component {n} is unreachable from the entry point")
        if not edges.get(n):
            err(f"component {n} has no outgoing router")
    return errors


DEFAULT_STAGES = [".pre", "build", "test", "deploy", ".post"]
RESERVED = {"stages", "variables", "default", "include", "workflow", "image", "services", "cache", "before_script", "after_script"}
TEMPLATE_JOBS = {"secret_detection"}  # provided by the included Secret-Detection template


def validate_ci(path: Path) -> list[str]:
    errors: list[str] = []
    ci = yaml.safe_load(path.read_text())
    stages = [".pre", *ci.get("stages", DEFAULT_STAGES), ".post"]
    jobs = {k: v for k, v in ci.items() if k not in RESERVED and not k.startswith(".") and isinstance(v, dict)}
    known = set(jobs) | TEMPLATE_JOBS
    for name, job in jobs.items():
        if "script" not in job and "trigger" not in job and name not in TEMPLATE_JOBS and not job.get("extends"):
            errors.append(f"job {name}: has no script")
        stage = job.get("stage", "test")
        if stage not in stages:
            errors.append(f"job {name}: stage '{stage}' is not declared")
        for need in job.get("needs", []) or []:
            ref = need.get("job") if isinstance(need, dict) else need
            if ref not in known:
                errors.append(f"job {name}: needs unknown job '{ref}'")
        if "omnis" in (job.get("tags") or []):
            errors.append(f"job {name}: pinned to a private runner tag")
    if "default" in ci and "omnis" in (ci["default"].get("tags") or []):
        errors.append("default: pinned to a private runner tag")
    return errors


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    problems = []
    flows = sorted((root / ".gitlab/duo/flows").glob("*.yml"))
    if not flows:
        problems.append("no flow definitions found in .gitlab/duo/flows/")
    for f in flows:
        problems += [f"{f.relative_to(root)}: {e}" for e in validate_flow(f)]
    problems += [f".gitlab-ci.yml: {e}" for e in validate_ci(root / ".gitlab-ci.yml")]
    if not (root / "AGENTS.md").exists():
        problems.append("AGENTS.md is missing")
    for p in problems:
        print(f"FAIL  {p}")
    print(f"Validated {len(flows)} flow(s) and .gitlab-ci.yml: {'OK' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
