"""Integrate published upstream releases using only the fork's Actions token."""

import base64
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

from github_api import (
    ACTIONS_APP_ID,
    APIError,
    CI_JOBS,
    CONTEXT,
    FORK,
    FORK_ID,
    UPSTREAM,
    UPSTREAM_ID,
    GitHub,
    fork_api,
    protected_automation,
)

STABLE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
REPLAY = re.compile(r"werft-replay-[a-z0-9][a-z0-9-]{0,31}")
SHA = re.compile(r"[a-f0-9]{40}")
PRODUCT_BASE = "werft"
SEED = {
    "tag": "v0.7.0",
    "release_id": 453439314,
    "sha": "0292b85bcce080cc685f85d174a8cb2cc553a0ad",
}
HISTORICAL_REPLAY_FILES = {
    ".github/workflows/ci.yml",
    ".github/workflows/notify-website-announcement.yml",
    "scripts/smoke-plan-labels.mjs",
}
CI_VALIDATE_JOB = "Validate Werft candidate"


class Refusal(Exception):
    def __init__(self, reason, step, **details):
        super().__init__(reason)
        self.step = step
        self.details = details


def version(tag):
    return tuple(map(int, STABLE.fullmatch(tag).groups()))


def now():
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")


def git(args, *, stdin=None, allow_failure=False, env=None):
    result = subprocess.run(
        ["git", *args], input=stdin, text=True, capture_output=True, env=env, check=False,
    )
    if result.returncode and not allow_failure:
        raise RuntimeError(f"git {args[0]} failed: {result.stderr.strip()[:1000]}")
    return result


class Repository:
    def __init__(self, token):
        credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        # Scope the transient header to the fork. Never authenticate upstream reads.
        self.auth = {
            **os.environ,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": f"http.https://github.com/{FORK}.git.extraheader",
            "GIT_CONFIG_VALUE_0": f"Authorization: basic {credentials}",
        }
        self.url = f"https://github.com/{FORK}.git"

    def push(self, sha, branch, expected):
        ref = f"refs/heads/{branch}"
        git(["push", "--porcelain", f"--force-with-lease={ref}:{expected or ''}",
             self.url, f"{sha}:{ref}"], env=self.auth)

    def fetch(self, remote, ref):
        git(["fetch", "--no-tags", remote, ref], env=self.auth)
        return git(["rev-parse", "FETCH_HEAD^{commit}"]).stdout.strip()

    def fork_branch(self, branch, sha):
        if self.fetch(self.url, f"refs/heads/{branch}") != sha:
            raise Refusal("base_moved", "fetch_base")

    def advertised_tags(self):
        remote = f"https://github.com/{UPSTREAM}.git"
        refs = {}
        for line in git(["ls-remote", "--tags", remote]).stdout.splitlines():
            sha, ref = line.split("\t", 1)
            refs[ref] = sha
        prefix = "refs/tags/"
        return {
            ref.removeprefix(prefix): refs.get(ref + "^{}", sha)
            for ref, sha in refs.items()
            if ref.startswith(prefix) and not ref.endswith("^{}")
        }

    def upstream_tag(self, release):
        remote = f"https://github.com/{UPSTREAM}.git"
        fetched = self.fetch(remote, f"refs/tags/{release['tag']}")
        if fetched != release["sha"]:
            raise Refusal("moved_tag", "fetch_tag")

    def commit(self, tree, parents, message, date=None):
        identity = {
            **os.environ,
            "GIT_AUTHOR_NAME": "github-actions[bot]",
            "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
            "GIT_COMMITTER_NAME": "github-actions[bot]",
            "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
        }
        if date:
            identity.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
        args = ["commit-tree", tree]
        for parent in parents:
            args.extend(["-p", parent])
        return git(args, stdin=message, env=identity).stdout.strip()

    def ancestor(self, old, new):
        result = git(["merge-base", "--is-ancestor", old, new], allow_failure=True)
        if result.returncode not in (0, 1):
            raise RuntimeError(f"Git could not verify ancestry: {result.stderr.strip()}")
        return result.returncode == 0

    def candidate(self, base, release):
        incoming = release["sha"]
        merged = git(["merge-tree", "--write-tree", base, incoming], allow_failure=True)
        if merged.returncode == 1:
            raise Refusal("merge_conflict", "merge_tree",
                          conflicts=merged.stdout.splitlines()[1:30])
        if merged.returncode:
            raise RuntimeError(f"Git could not build candidate: {merged.stderr.strip()}")
        tree = merged.stdout.splitlines()[0]
        date = git(["show", "-s", "--format=%cI", base]).stdout.strip()
        return self.commit(tree, [base, incoming],
                           f"Merge upstream {release['tag']} into Werft\n", date=date)


class Journal:
    def __init__(self, api, repo, base, seed, base_sha):
        self.repo = repo
        self.branch = f"werft-updates/state/{base}"
        self.tip = api.branch_sha(self.branch, missing=True)
        if self.tip:
            if repo.fetch(repo.url, f"refs/heads/{self.branch}") != self.tip:
                raise RuntimeError("Update journal changed while reading")
            self.data = json.loads(git(["show", f"{self.tip}:state.json"]).stdout)
            if (self.data["schema"], self.data["upstream_repository_id"], self.data["base_ref"]) != (
                1, UPSTREAM_ID, base,
            ):
                raise RuntimeError("Unrecognized update journal")
        else:
            self.data = {
                "schema": 1,
                "upstream_repository_id": UPSTREAM_ID,
                "base_ref": base,
                "accepted": seed,
                "last_successful_base_sha": base_sha,
                "seen": {seed["tag"]: seed},
                "last_successful_poll_at": None,
                "candidate": None,
                "last_refusal": None,
                "outcome": None,
            }

    def save(self):
        payload = json.dumps(self.data, indent=2, sort_keys=True) + "\n"
        blob = git(["hash-object", "-w", "--stdin"], stdin=payload).stdout.strip()
        tree = git(["mktree"], stdin=f"100644 blob {blob}\tstate.json\n").stdout.strip()
        parents = [self.tip] if self.tip else []
        sha = self.repo.commit(tree, parents, "Record Werft update state\n")
        self.repo.push(sha, self.branch, self.tip)
        self.tip = sha


def stable_releases(upstream):
    if upstream.request()["id"] != UPSTREAM_ID:
        raise Refusal("upstream_identity_changed", "list_releases")
    releases = {}
    for release in upstream.pages("releases"):
        tag = release["tag_name"]
        if release["draft"] or release["prerelease"] or not release["published_at"]:
            continue
        if STABLE.fullmatch(tag):
            if tag in releases:
                raise Refusal("ambiguous_release", "list_releases", upstream_tag=tag)
            releases[tag] = release["id"]
    return releases


def resolve_release(upstream, tag, release_id):
    ref = upstream.request(f"git/ref/tags/{tag}", missing=True)
    if ref is None:
        raise Refusal("vanished_tag", "resolve_tag", upstream_tag=tag)
    obj = ref["object"]
    for _ in range(8):
        if obj["type"] == "commit" and SHA.fullmatch(obj["sha"]):
            return {"tag": tag, "release_id": release_id, "sha": obj["sha"]}
        if obj["type"] != "tag" or not SHA.fullmatch(obj["sha"]):
            break
        obj = upstream.request(f"git/tags/{obj['sha']}")["object"]
    raise Refusal("unsupported_tag", "resolve_tag", upstream_tag=tag)


def observe(upstream, repo, journal, releases, through, refresh=False):
    seen = journal.data["seen"]
    advertised = repo.advertised_tags()
    accepted = journal.data["accepted"]["tag"]
    for tag in sorted(seen.keys() | releases.keys(), key=version):
        if tag not in seen and (version(tag) <= version(accepted) or version(tag) > through):
            continue
        if tag not in releases:
            raise Refusal("vanished_release", "list_releases", upstream_tag=tag)
        previous = seen.get(tag)
        if previous and previous["release_id"] != releases[tag]:
            raise Refusal("vanished_release", "list_releases", upstream_tag=tag)
        observed_sha = advertised.get(tag)
        if observed_sha is None:
            raise Refusal("vanished_tag", "advertised_tags", upstream_tag=tag)
        if previous:
            if previous["sha"] != observed_sha:
                raise Refusal("moved_tag", "advertised_tags", upstream_tag=tag,
                              expected=previous["sha"], observed=observed_sha)
        else:
            release = resolve_release(upstream, tag, releases[tag])
            if release["sha"] != observed_sha:
                raise Refusal("moved_tag", "resolve_tag", upstream_tag=tag,
                              expected=observed_sha, observed=release["sha"])
            seen[tag] = release
            # Pin tag identity before doing any write to the candidate or PR.
            journal.save()
    if refresh:
        journal.data["last_successful_poll_at"] = now()
        journal.save()


def classify(repo, base_sha, previous, release, replay):
    incoming = release["sha"]
    old = previous["sha"]
    if not repo.ancestor(old, incoming):
        raise Refusal("non_descendant", "check_ancestry")
    package = json.loads(git(["show", f"{incoming}:package.json"]).stdout)
    old_package = json.loads(git(["show", f"{old}:package.json"]).stdout)
    diff = git(["diff", "--name-only", "--no-renames", "-z", old, incoming]).stdout
    paths = sorted(path for path in diff.split("\0") if protected_automation(path))
    if old_package.get("scripts") != package.get("scripts"):
        paths.append("package.json")
    ci = git(["show", f"{incoming}:.github/workflows/ci.yml"], allow_failure=True).stdout
    node_versions = set(re.findall(r'^\s*node-version:\s*["\']?([^"\'\s#]+)', ci, re.M))
    targets = set(re.findall(r"^\s*- os: ([a-z0-9.-]+)\s+platform: ([a-z0-9-]+)\s*$", ci, re.M))
    supported_targets = {
        ("macos-15", "mac-arm64"),
        ("windows-2025", "windows-x64"),
        ("ubuntu-24.04", "linux-x64"),
    }
    if (
        package.get("engines", {}).get("node") not in (None, "26", "26.x", "26.13.1")
        or package.get("devEngines", {}).get("runtime")
        or any(package.get(field) for field in ("os", "cpu", "libc"))
        or node_versions != {"26"}
        or targets != supported_targets
    ):
        raise Refusal("unknown_runtime_target", "check_runtime",
                      node_versions=sorted(node_versions), targets=sorted(targets),
                      files=paths)
    if paths and not (
        replay and release == SEED and set(paths) == HISTORICAL_REPLAY_FILES
        and not git(["diff", "--name-only", base_sha, incoming, "--", *paths]).stdout
    ):
        raise Refusal("automation_changed", "check_automation", files=paths)


def strict_guard(api, branch):
    rules = api.request(f"rules/branches/{urllib.parse.quote(branch)}")
    strict_status = any(
        rule["type"] == "required_status_checks"
        and rule["parameters"]["strict_required_status_checks_policy"]
        and {"context": CONTEXT, "integration_id": ACTIONS_APP_ID}
        in rule["parameters"]["required_status_checks"]
        for rule in rules
    )
    merge_only = any(rule["type"] == "pull_request"
                     and rule["parameters"]["allowed_merge_methods"] == ["merge"]
                     for rule in rules)
    if not (strict_status and merge_only and any(rule["type"] == "non_fast_forward" for rule in rules)):
        raise Refusal("missing_protection", "check_ruleset")


def candidate_branch(base, tag):
    return f"werft-updates/integrate/{base}/{tag}"


def matching_pr(api, branch, base):
    matches = list(api.pages("pulls", state="all", head=f"{FORK.split('/')[0]}:{branch}"))
    if len(matches) > 1:
        raise Refusal("duplicate_pull_requests", "find_pull_request")
    if matches and (
        matches[0]["base"]["ref"] != base
        or matches[0]["head"]["repo"]["id"] != FORK_ID
        or matches[0]["head"]["ref"] != branch
        or matches[0]["user"]["login"] != "github-actions[bot]"
    ):
        raise Refusal("unexpected_pull_request", "find_pull_request")
    return matches[0] if matches else None


def open_pr(api, branch, base, release):
    title = f"Merge upstream {release['tag']} into {base}"
    body = (
        f"Published upstream release ID `{release['release_id']}` at `{release['sha']}`.\n\n"
        "The Werft update workflow validates the full CI matrix before merging."
    )
    pr = api.request("pulls", "POST", {"title": title, "body": body, "head": branch, "base": base})
    print(f"Created {pr['html_url']}", flush=True)
    return pr


def assert_pr(pr, candidate, base):
    if (
        pr["state"] != "open" or pr["draft"] or pr["base"]["ref"] != base
        or pr["base"]["repo"]["id"] != FORK_ID or pr["head"]["repo"]["id"] != FORK_ID
        or pr["head"]["ref"] != candidate_branch(base, candidate["tag"])
        or pr["head"]["sha"] != candidate["sha"]
        or pr["user"]["login"] != "github-actions[bot]"
    ):
        raise Refusal("candidate_changed", "verify_pull_request")
    if pr["base"]["sha"] != candidate["base_sha"]:
        raise Refusal("base_moved", "verify_pull_request")


def run_title(candidate):
    return (f"Werft CI {candidate['sha']} on {candidate['base_sha']} "
            f"for https://github.com/{FORK}/pull/{candidate['pr']}")


def wait_for_ci(api, candidate, base, controller):
    deadline = time.monotonic() + 32 * 60
    expected_workflow = api.request("actions/workflows/ci.yml")["id"]
    while time.monotonic() < deadline:
        if api.branch_sha(base) != candidate["base_sha"]:
            raise Refusal("base_moved", "wait_for_checks")
        run = api.request(f"actions/runs/{candidate['run_id']}", missing=True)
        if run and (
            run["workflow_id"] != expected_workflow or run["event"] != "workflow_dispatch"
            or run["head_branch"] != controller["ref"] or run["head_sha"] != controller["sha"]
            or run["repository"]["id"] != FORK_ID or run["head_repository"]["id"] != FORK_ID
            or run["actor"]["login"] != "github-actions[bot]" or run["display_title"] != run_title(candidate)
        ):
            raise Refusal("unexpected_check_run", "verify_checks")
        if run and run["status"] == "completed":
            if run["conclusion"] != "success" or not api.checked_jobs(
                run["id"], run["run_attempt"], CI_JOBS | {CI_VALIDATE_JOB},
            ):
                raise Refusal("red_checks", "verify_checks", run_url=run["html_url"])
            return run
        time.sleep(20)
    raise Refusal("checks_pending", "wait_for_checks")


def prepare_candidate(api, repo, journal, base_sha, release, branch, pr):
    active = journal.data["candidate"]
    same_release = active and active["tag"] == release["tag"]
    if same_release and active["base_sha"] == base_sha:
        return active

    live_sha = api.branch_sha(branch, missing=True)
    allowed_previous = active["sha"] if same_release else None
    journaled_predecessor = active["previous_sha"] if same_release else None
    sha = repo.candidate(base_sha, release)
    if live_sha not in (None, allowed_previous, journaled_predecessor, sha) or (pr and live_sha is None):
        raise Refusal("candidate_changed", "prepare_candidate", expected=allowed_previous, observed=live_sha)
    candidate = {
        "tag": release["tag"], "base_sha": base_sha, "sha": sha,
        "previous_sha": live_sha, "pr": pr["number"] if pr else None,
        "run_id": None, "controller": None, "merge_sha": None,
    }
    journal.data["candidate"] = candidate
    journal.save()
    return candidate


def publish_candidate(api, repo, journal, candidate, branch, base, release, pr):
    live_sha = api.branch_sha(branch, missing=True)
    if live_sha != candidate["sha"]:
        if live_sha != candidate["previous_sha"]:
            raise Refusal("candidate_changed", "push_candidate")
        # The base most recently fetched by this run may be newer than the
        # journaled head. Fetch/reconstruct a previously journaled head on retry.
        sha = repo.candidate(candidate["base_sha"], release)
        if sha != candidate["sha"]:
            raise Refusal("candidate_changed", "rebuild_candidate")
        repo.push(sha, branch, live_sha)
    if not pr:
        pr = open_pr(api, branch, base, release)
    # The API may briefly report the previous PR head after a ref update.
    for _ in range(6):
        pr = api.request(f"pulls/{pr['number']}")
        if pr["head"]["sha"] == candidate["sha"]:
            break
        time.sleep(3)
    assert_pr(pr, candidate, base)
    if candidate["pr"] != pr["number"]:
        candidate["pr"] = pr["number"]
        journal.save()
    return pr


def get_merge(api, candidate, base):
    if candidate["pr"] is None:
        return None
    # The 2026 REST representation drops merge_commit_sha on merged PRs.
    pr = api.request(f"pulls/{candidate['pr']}", version="2022-11-28")
    if not pr["merged"]:
        return None
    if (
        pr["head"]["sha"] != candidate["sha"] or pr["base"]["ref"] != base
        or pr["head"]["ref"] != candidate_branch(base, candidate["tag"])
        or pr["merged_by"]["login"] != "github-actions[bot]"
    ):
        raise Refusal("unexpected_merge", "verify_merge")
    return verify_merge_parents(api, candidate, pr.get("merge_commit_sha"))


def verify_merge_parents(api, candidate, merge_sha):
    if not SHA.fullmatch(merge_sha or ""):
        raise Refusal("unexpected_merge", "verify_merge")
    commit = api.request(f"git/commits/{merge_sha}")
    if [parent["sha"] for parent in commit["parents"]] != [candidate["base_sha"], candidate["sha"]]:
        raise Refusal("unexpected_merge", "verify_merge")
    return commit["sha"]


def complete(api, repo, journal, candidate, release, base, replay, merge_sha=None):
    if merge_sha:
        merge_sha = verify_merge_parents(api, candidate, merge_sha)
    else:
        merge_sha = candidate["merge_sha"] or get_merge(api, candidate, base)
    if not merge_sha:
        raise Refusal("unexpected_merge", "verify_merge")
    candidate["merge_sha"] = merge_sha
    journal.save()

    outcome = {"state": "merged", "upstream_tag": release["tag"], "candidate_commit": candidate["sha"],
               "merge_sha": merge_sha, "recorded_at": now()}
    if not replay:
        workflow = api.request(f"contents/.github/workflows/werft-release.yml?ref={merge_sha}", missing=True)
        if workflow is None:
            outcome["release"] = "release workflow not present"
        else:
            handoff = api.dispatch("werft-release.yml", PRODUCT_BASE, {
                "merge_sha": merge_sha, "upstream_tag": release["tag"],
            })
            outcome["release"] = f"https://github.com/{FORK}/actions/runs/{handoff['workflow_run_id']}"

    journal.data.update(accepted=release, candidate=None,
                        last_successful_base_sha=merge_sha, outcome=outcome)
    journal.save()
    branch = candidate_branch(base, release["tag"])
    if api.branch_sha(branch, missing=True) == candidate["sha"]:
        ref = f"refs/heads/{branch}"
        git(["push", "--porcelain", f"--force-with-lease={ref}:{candidate['sha']}", repo.url, f":{ref}"],
            env=repo.auth)
    print(json.dumps(outcome), flush=True)


def integrate(api, upstream, repo, journal, release, base, replay, retry):
    base_sha = api.branch_sha(base)
    active = journal.data["candidate"]
    last_refusal = journal.data["last_refusal"]
    if active and active["tag"] == release["tag"] and active["base_sha"] != base_sha and not (
        last_refusal and last_refusal["candidate_commit"] == active["sha"]
        and last_refusal["reason"] == "base_moved"
    ):
        raise Refusal("base_moved", "check_base", expected=active["base_sha"], observed=base_sha)
    repo.fork_branch(base, base_sha)
    repo.upstream_tag(journal.data["accepted"])
    repo.upstream_tag(release)
    classify(repo, base_sha, journal.data["accepted"], release, replay)
    if not (
        repo.ancestor(journal.data["last_successful_base_sha"], base_sha)
        and repo.ancestor(journal.data["accepted"]["sha"], base_sha)
    ):
        raise Refusal("non_descendant", "check_base_history")
    strict_guard(api, base)
    branch = candidate_branch(base, release["tag"])
    pr = matching_pr(api, branch, base)
    if pr and pr["state"] != "open":
        raise Refusal("closed_pull_request", "find_pull_request")
    candidate = prepare_candidate(api, repo, journal, base_sha, release, branch, pr)
    pr = publish_candidate(api, repo, journal, candidate, branch, base, release, pr)
    previous = journal.data["last_refusal"]
    if previous and previous["reason"] == "red_checks" and previous["candidate_commit"] == candidate["sha"]:
        if not retry:
            raise Refusal("red_checks", "verify_checks", **previous["details"])
        # An explicit retry starts a new check, never a new PR.
        candidate["run_id"] = None
        journal.save()
    if candidate["run_id"] is None:
        controller = {"ref": os.environ["GITHUB_REF_NAME"], "sha": os.environ["GITHUB_SHA"]}
        if api.branch_sha(controller["ref"]) != controller["sha"]:
            raise Refusal("controller_moved", "dispatch_checks")
        run = api.dispatch("ci.yml", controller["ref"], {
            "candidate_sha": candidate["sha"], "base_sha": candidate["base_sha"],
            "pr": str(candidate["pr"]),
        })
        candidate.update(run_id=run["workflow_run_id"], controller=controller)
        journal.save()
        run_url = f"https://github.com/{FORK}/actions/runs/{candidate['run_id']}"
        api.status(candidate["sha"], "pending", "Werft candidate CI dispatched", run_url)
    run = wait_for_ci(api, candidate, base, candidate["controller"])
    observe(upstream, repo, journal, stable_releases(upstream), version(release["tag"]))
    earlier = sorted(
        (tag for tag in journal.data["seen"]
         if version(journal.data["accepted"]["tag"]) < version(tag) < version(release["tag"])),
        key=version,
    )
    if earlier:
        raise Refusal("earlier_release_found", "verify_release_order", earlier_tag=earlier[0])
    assert_pr(api.request(f"pulls/{pr['number']}"), candidate, base)
    strict_guard(api, base)
    api.status(candidate["sha"], "success", "Werft candidate CI passed", run["html_url"])
    merge_sha = merge_candidate(api, candidate, base)
    complete(api, repo, journal, candidate, release, base, replay, merge_sha)


def merge_candidate(api, candidate, base):
    pr = candidate["pr"]
    for attempt in range(6):
        assert_pr(api.request(f"pulls/{pr}"), candidate, base)
        try:
            result = api.request(f"pulls/{pr}/merge", "PUT", {
                "merge_method": "merge",
                "sha": candidate["sha"],
            })
        except APIError as error:
            if api.branch_sha(base) != candidate["base_sha"]:
                raise Refusal("base_moved", "merge_pull_request") from error
            if error.status not in {405, 409} or attempt == 5:
                raise
            # GitHub can take a moment to reevaluate a newly posted status.
            time.sleep(3)
            continue
        if not result["merged"]:
            raise Refusal("merge_rejected", "merge_pull_request")
        return result.get("sha")


def record_refusal(api, journal, failure, current_tag):
    active = journal.data["candidate"]
    tag = failure.details.get("upstream_tag", current_tag)
    sha = active["sha"] if active and active["tag"] == tag else None
    target_url = f"https://github.com/{FORK}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    refusal = {
        "state": "refused", "reason": str(failure), "step": failure.step,
        "upstream_tag": tag, "candidate_commit": sha, "details": failure.details,
        "recorded_at": now(), "run_url": target_url,
    }
    previous = journal.data["last_refusal"]
    if previous and all(previous[key] == refusal[key] for key in (
        "reason", "step", "upstream_tag", "candidate_commit", "details",
    )):
        print(json.dumps(previous), flush=True)
        return
    journal.data.update(last_refusal=refusal, outcome=refusal)
    journal.save()
    if sha and active["pr"] and not active["merge_sha"] and str(failure) != "checks_pending":
        api.status(sha, "failure", f"Werft update refused: {failure}", target_url)
    print(json.dumps(refusal), flush=True)


def main():
    api = fork_api()
    upstream = GitHub(UPSTREAM, api.token)
    repo = Repository(api.token)
    if api.request()["id"] != FORK_ID:
        raise RuntimeError("Fork identity changed")
    base = os.environ.get("UPDATE_BASE") or PRODUCT_BASE
    replay = base != PRODUCT_BASE
    start = os.environ.get("REPLAY_START", "")
    end = os.environ.get("REPLAY_END", "")
    retry = os.environ.get("RETRY_FAILED", "") == "true"
    if replay:
        if not REPLAY.fullmatch(base) or not STABLE.fullmatch(start) or not STABLE.fullmatch(end):
            raise RuntimeError("Replay requires a werft-replay-* base and two stable release tags")
        if version(start) >= version(end) or version(end) > version(SEED["tag"]):
            raise RuntimeError("Replay bounds must be ordered and end at or before the production seed")
        through = version(end)
        seed = None
    else:
        if os.environ["GITHUB_REF_NAME"] != PRODUCT_BASE or start or end:
            raise RuntimeError("Production updates must run from werft without replay inputs")
        through = (float("inf"),)
        seed = SEED
    base_sha = api.branch_sha(base)
    if replay:
        releases = stable_releases(upstream)
        if start not in releases:
            raise RuntimeError("Replay seed must be a published stable release")
        seed = resolve_release(upstream, start, releases[start])
    journal = Journal(api, repo, base, seed, base_sha)
    current_tag = seed["tag"]
    try:
        active = journal.data["candidate"]
        if active and (active["merge_sha"] or get_merge(api, active, base)):
            current_tag = active["tag"]
            complete(api, repo, journal, active, journal.data["seen"][current_tag], base, replay)
        observe(upstream, repo, journal, stable_releases(upstream), through, refresh=True)
        for tag in sorted(journal.data["seen"], key=version):
            if not version(journal.data["accepted"]["tag"]) < version(tag) <= through:
                continue
            current_tag = tag
            active = journal.data["candidate"]
            if not active or active["tag"] != tag:
                postponed = journal.data.setdefault("postponed_candidates", {})
                if active:
                    postponed[active["tag"]] = active
                journal.data["candidate"] = postponed.pop(tag, None)
                journal.save()
            integrate(api, upstream, repo, journal, journal.data["seen"][tag], base, replay, retry)
    except Refusal as failure:
        record_refusal(api, journal, failure, current_tag)
        if str(failure) != "checks_pending":
            return 1
    except (APIError, OSError, RuntimeError) as failure:
        record_refusal(api, journal, Refusal("operation_failed", "update", error=str(failure)[:800]),
                       current_tag)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
