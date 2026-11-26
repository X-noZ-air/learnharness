"""Publish the common gate for feature PRs without executing their code."""

import json
import os

from github_api import CI_JOBS, FORK_ID, fork_api, protected_automation


def reviewed_automation(api, pr):
    number = pr["number"]
    touches_automation = any(
        protected_automation(path)
        for change in api.pages(f"pulls/{number}/files")
        for path in [change["filename"], change.get("previous_filename", "")]
    )
    if not touches_automation:
        return True
    latest = {}
    for review in api.pages(f"pulls/{number}/reviews"):
        if review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            latest[review["user"]["login"]] = review
    for login, review in latest.items():
        if (
            review["state"] != "APPROVED" or review["commit_id"] != pr["head"]["sha"]
            or login == pr["user"]["login"] or review["user"]["type"] != "User"
        ):
            continue
        permission = api.request(f"collaborators/{login}/permission", missing=True)
        if permission and permission["permission"] in {"admin", "maintain", "write"}:
            return True
    return False


def main():
    api = fork_api()
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event:
        run = json.load(event)["workflow_run"]
    workflow = api.request("actions/workflows/ci.yml")
    if (
        run["workflow_id"] != workflow["id"] or run["event"] != "pull_request"
        or run["repository"]["id"] != FORK_ID or run["head_repository"] is None
    ):
        return
    jobs = list(api.pages(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs"))
    passed = run["conclusion"] == "success" and {
        job["name"] for job in jobs if job["conclusion"] == "success"
    } == CI_JOBS

    # The workflow_run payload can omit pull_requests for public forks.
    for pr in api.pages("pulls", state="open", base="werft"):
        head = pr["head"]
        if (
            head["repo"] is None or head["repo"]["id"] != run["head_repository"]["id"]
            or head["ref"] != run["head_branch"] or head["sha"] != run["head_sha"]
            or head["ref"].startswith("werft-updates/integrate/")
        ):
            continue
        current = api.request(f"pulls/{pr['number']}")
        if current["head"]["sha"] != head["sha"] or current["base"]["ref"] != "werft":
            continue
        # An older run must not overwrite a newer result for this same head.
        runs = api.pages("actions/workflows/ci.yml/runs", "workflow_runs",
                         event="pull_request", head_sha=head["sha"])
        if any(
            other["id"] > run["id"]
            and other["head_repository"] and other["head_repository"]["id"] == head["repo"]["id"]
            and other["head_branch"] == head["ref"]
            for other in runs
        ):
            continue
        approved = reviewed_automation(api, current)
        api.status(head["sha"], "success" if passed and approved else "failure",
                   "Feature CI passed" if passed and approved else (
                       "Automation changes require maintainer review" if not approved else "Feature CI failed"
                   ), run["html_url"])


if __name__ == "__main__":
    main()
