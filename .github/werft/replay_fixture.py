"""Disposable fixture entry point for the pre-merge Actions replay."""

import os
import tempfile
import time

from github_api import FORK, UPSTREAM, GitHub, fork_api
from update import HISTORICAL_REPLAY_FILES, REPLAY, SEED, Repository, git, resolve_release, stable_releases


def write_tree(base, contents):
    with tempfile.TemporaryDirectory() as temp:
        env = {**os.environ, "GIT_INDEX_FILE": f"{temp}/replay-index"}
        git(["read-tree", base], env=env)
        for path, content in contents.items():
            blob = git(["hash-object", "-w", "--stdin"], stdin=content).stdout.strip()
            git(["update-index", "--add", "--cacheinfo", f"100644,{blob},{path}"], env=env)
        return git(["write-tree"], env=env).stdout.strip()


def main():
    base = os.environ["REPLAY_BASE"]
    fixture = os.environ["FIXTURE"]
    if not REPLAY.fullmatch(base) or os.environ["GITHUB_REF_NAME"] != "fm/lh-m21-updatekette":
        raise RuntimeError("Replay fixtures can only mutate disposable replay branches")
    api = fork_api()
    repo = Repository(api.token)
    current = api.branch_sha(base, missing=True)
    if fixture in {"clean", "conflict"}:
        if current:
            raise RuntimeError("Choose a fresh test base")
        upstream = GitHub(UPSTREAM, api.token)
        start = os.environ["REPLAY_START"]
        seed = resolve_release(upstream, start, stable_releases(upstream)[start])
        repo.upstream_tag(seed)
        repo.upstream_tag(SEED)
        contents = {
            path: git(["show", f"{SEED['sha']}:{path}"]).stdout
            for path in HISTORICAL_REPLAY_FILES
        }
        if fixture == "conflict":
            path = "package.json"
            text = git(["show", f"{seed['sha']}:{path}"]).stdout
            contents[path] = text.replace(f'"version": "{start[1:]}"', '"version": "99.0.0"', 1)
        sha = repo.commit(write_tree(seed["sha"], contents), [seed["sha"]], "Prepare disposable replay fixture")
        repo.push(sha, base, None)
        print(f"Created {base} at {sha}")
    elif fixture == "move":
        repo.fork_branch(base, current)
        path = "werft-replay-fixture.txt"
        sha = repo.commit(write_tree(current, {path: "Test-only base movement.\n"}), [current],
                          "Advance disposable replay base")
        branch = f"{base}-advance"
        repo.push(sha, branch, None)
        pr = api.request("pulls", "POST", {"head": branch, "base": base, "title": "Advance replay fixture"})
        print(pr["html_url"], flush=True)
        url = f"https://github.com/{FORK}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        api.status(sha, "success", "Synthetic replay fixture", url)
        for _ in range(10):
            current_pr = api.request(f"pulls/{pr['number']}")
            if current_pr["mergeable_state"] == "clean":
                break
            time.sleep(3)
        result = api.request(f"pulls/{pr['number']}/merge", "PUT", {"sha": sha, "merge_method": "merge"})
        if not result["merged"]:
            raise RuntimeError("Could not advance isolated replay base")
        print(result["sha"])
    else:
        raise RuntimeError("Unknown replay fixture")


if __name__ == "__main__":
    main()
