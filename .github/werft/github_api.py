"""GitHub API calls shared by the Werft update workflows."""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

FORK = "X-noZ-air/learnharness"
UPSTREAM = "amosblomqvist/learnharness"
FORK_ID = 1473691789
UPSTREAM_ID = 1422597771
CONTEXT = "werft/ci"
ACTIONS_APP_ID = 15368
CI_JOBS = {
    "Typecheck, tests, lint",
    "Standalone (mac-arm64)",
    "Standalone (windows-x64)",
    "Standalone (linux-x64)",
}


class APIError(Exception):
    def __init__(self, status, method, path, message):
        super().__init__(f"GitHub {method} {path}: {status} {message}")
        self.status = status


class GitHub:
    def __init__(self, repo, token=None):
        self.repo = repo
        self.token = token

    def request(self, path="", method="GET", data=None, missing=False, version="2026-03-10"):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}{'/' if path else ''}{path}",
            data=None if data is None else json.dumps(data).encode(),
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": version,
                "User-Agent": "learnharness-werft-updates",
            },
        )
        if self.repo == UPSTREAM and method != "GET":
            raise RuntimeError("Upstream API is read-only")
        if self.token:
            request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and missing:
                return None
            payload = exc.read().decode(errors="replace")
            raise APIError(exc.code, method, path, payload) from exc

    def pages(self, path, field=None, **query):
        page = 1
        while True:
            params = urllib.parse.urlencode({**query, "per_page": 100, "page": page})
            response = self.request(f"{path}?{params}")
            entries = response if field is None else response[field]
            yield from entries
            if len(entries) < 100:
                return
            page += 1

    def branch_sha(self, branch, missing=False):
        ref = self.request(f"git/ref/heads/{urllib.parse.quote(branch)}", missing=missing)
        return ref["object"]["sha"] if ref else None

    def dispatch(self, workflow, ref, inputs):
        return self.request(f"actions/workflows/{workflow}/dispatches", "POST", {
            "ref": ref, "inputs": inputs, "return_run_details": True,
        })

    def status(self, sha, state, description, target_url):
        self.request(f"statuses/{sha}", "POST", {
            "context": CONTEXT,
            "state": state,
            "description": description,
            "target_url": target_url,
        })

    def checked_jobs(self, run_id, attempt, names):
        jobs = list(self.pages(f"actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs"))
        required = [job for job in jobs if job["name"] in names]
        return (
            len(required) == len(names)
            and {job["name"] for job in required} == names
            and all(job["conclusion"] == "success" for job in required)
        )


def fork_api():
    if os.environ["GITHUB_REPOSITORY_ID"] != str(FORK_ID):
        raise RuntimeError("This workflow can only operate on the LearnHarness fork")
    return GitHub(FORK, os.environ["GH_TOKEN"])


def protected_automation(path):
    return (
        path.startswith((".github/", "scripts/", "ops/"))
        or path in {"AGENTS.md", "CLAUDE.md", "electron-builder.yml"}
    )
