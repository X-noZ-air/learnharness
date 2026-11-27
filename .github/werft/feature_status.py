"""Publish the common gate for feature PRs without executing their code."""

import json
import os

from github_api import CI_JOBS, FORK_ID, fork_api


def werft_pr(run):
    associated = run.get("pull_requests") or []
    if len(associated) != 1 or not run.get("head_repository"):
        return None
    pr = associated[0]
    head, base = pr["head"], pr["base"]
    if (
        base["repo"]["id"] == FORK_ID and base["ref"] == "werft"
        and head["repo"]["id"] == run["head_repository"]["id"]
        and head["ref"] == run["head_branch"] and head["sha"] == run["head_sha"]
        and not head["ref"].startswith("werft-updates/integrate/")
    ):
        return pr
    return None


def main():
    api = fork_api()
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event:
        run = json.load(event)["workflow_run"]
    workflow = api.request("actions/workflows/ci.yml")
    if (
        run["workflow_id"] != workflow["id"] or run["event"] != "pull_request"
        or run["repository"]["id"] != FORK_ID
    ):
        return
    pr = werft_pr(run)
    if not pr:
        return
    number = pr["number"]
    current = api.request(f"pulls/{number}")
    head = current["head"]
    if (
        current["state"] != "open" or current["base"]["ref"] != "werft"
        or current["base"]["repo"]["id"] != FORK_ID or current["base"]["sha"] != pr["base"]["sha"]
        or head["repo"] is None or head["repo"]["id"] != pr["head"]["repo"]["id"]
        or head["ref"] != pr["head"]["ref"] or head["sha"] != pr["head"]["sha"]
    ):
        return
    jobs = list(api.pages(f"actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs"))
    passed = run["conclusion"] == "success" and {
        job["name"] for job in jobs if job["conclusion"] == "success"
    } == CI_JOBS

    # An older run must not overwrite a newer result for this same head.
    runs = api.pages("actions/workflows/ci.yml/runs", "workflow_runs",
                     event="pull_request", head_sha=head["sha"])
    for other in runs:
        if other["id"] > run["id"] and (other_pr := werft_pr(other)) and other_pr["number"] == number:
            return
    api.status(
        head["sha"], "success" if passed else "failure",
        "Feature CI passed" if passed else "Feature CI failed",
        run["html_url"],
    )


if __name__ == "__main__":
    main()
