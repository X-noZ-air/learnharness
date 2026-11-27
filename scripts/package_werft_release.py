#!/usr/bin/env python3
"""Assemble and unpack the release assets for the CI standalone smoke."""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from verify_werft_release import FILES, METADATA, NOTICE, RUNTIME, SOURCE, SUMS, measure, require, sha256, unpack
from werft_third_party import generate_notice


def main():
    assets, destination = (Path(arg).resolve() for arg in sys.argv[1:])
    tag, commit, upstream_tag, upstream_commit = (
        os.environ[name] for name in ("RELEASE_TAG", "GITHUB_SHA", "UPSTREAM_TAG", "UPSTREAM_COMMIT")
    )
    runtime = json.loads(subprocess.check_output([
        "node", "-p", """JSON.stringify({
            node_version: process.versions.node, node_abi: Number(process.versions.modules),
            os: process.platform, arch: process.arch,
            glibc_version: process.report.getReport().header.glibcVersionRuntime
        })""",
    ]))
    require(runtime["node_version"] == os.environ["NODE_VERSION"], "unexpected Node version")
    require(runtime["os"] == "linux" and runtime["arch"] == "x64"
            and platform.machine() == "x86_64", "release requires Linux x64")
    standalone = Path(".next/standalone")
    package = json.loads((standalone / "package.json").read_text())
    require(package["version"] == upstream_tag[1:], "package version differs from upstream tag")

    assets.mkdir()
    shutil.copyfile("LICENSE", standalone / "LICENSE")
    (assets / NOTICE).write_text(generate_notice(standalone))
    shutil.copyfile(assets / NOTICE, standalone / NOTICE)
    subprocess.run([
        "tar", "--create", "--gzip", "--hard-dereference", "--file", assets / RUNTIME,
        "--directory", standalone, ".",
    ], check=True)
    with subprocess.Popen(["git", "archive", "--format=tar", f"--prefix=learnharness-{commit}/", commit],
                          stdout=subprocess.PIPE) as git:
        with (assets / SOURCE).open("wb") as file:
            subprocess.run(["gzip", "-n"], stdin=git.stdout, stdout=file, check=True)
        if git.wait():
            raise RuntimeError("git archive failed")
    unpacked_bytes = measure(assets / RUNTIME)
    unpack(assets / RUNTIME, destination, unpacked_bytes)
    metadata = {
        "release_tag": tag, "fork_commit": commit, "upstream_tag": upstream_tag, "upstream_commit": upstream_commit,
        **runtime, "packed_bytes": (assets / RUNTIME).stat().st_size, "unpacked_bytes": unpacked_bytes,
        "package_version": package["version"],
    }
    (assets / METADATA).write_text(json.dumps(metadata, indent=2) + "\n")
    (assets / SUMS).write_text("".join(f"{sha256(assets / name)}  {name}\n" for name in FILES))


if __name__ == "__main__":
    main()
