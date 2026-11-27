#!/usr/bin/env python3
"""Verify a fork release and stage its standalone payload in a new directory."""
import argparse
import hashlib
import json
import os
import posixpath
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

REPO = "X-noZ-air/learnharness"
SIGNER = f"https://github.com/{REPO}/.github/workflows/werft-release.yml@refs/heads/werft"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
TAG_PATTERN = re.compile(rf"werft-({VERSION})\.([1-9][0-9]*)")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
RUNTIME = "learnharness-linux-x64.tar.gz"
SOURCE = "learnharness-source.tar.gz"
NOTICE = "learnharness-third-party-notice.json"
METADATA = "release-metadata.json"
SUMS = "SHA256SUMS"
PROVENANCE = "provenance.json"
FILES = (RUNTIME, SOURCE, NOTICE, METADATA)
ASSETS = (*FILES, SUMS, PROVENANCE)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def archive_members(archive):
    members = {}
    for entry in archive:
        require(not entry.name.startswith("/"), f"absolute archive path: {entry.name}")
        name = entry.name.removeprefix("./").rstrip("/")
        if not name or name == ".":
            require(entry.isdir(), "archive root must be a directory")
            continue
        parts = name.split("/")
        require(not any(part in ("", ".", "..") for part in parts)
                and "\\" not in name, f"unsafe archive path: {entry.name}")
        require(name not in members, f"duplicate archive path: {name}")
        require(entry.isfile() or entry.isdir() or entry.issym(), f"unsupported archive entry: {name}")
        require(not (entry.sparse or entry.mode & 0o7000), f"unsupported archive attributes: {name}")
        if entry.issym():
            link = entry.linkname
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
            require(link and not posixpath.isabs(link) and "\\" not in link
                    and target != ".." and not target.startswith("../"), f"unsafe symlink: {name}")
        members[name] = entry

    for name in members:
        for parent in PurePosixPath(name).parents:
            parent_entry = members.get(str(parent))
            require(parent_entry is None or parent_entry.isdir(), f"nondirectory archive parent: {name}")
    return members


def check_payload(destination, members):
    for name, entry in members.items():
        file = destination / name
        if entry.issym():
            require(file.resolve(strict=True).is_relative_to(destination), f"symlink escapes payload: {name}")
        if entry.isfile() and (file.suffix == ".node" or ".so" in file.suffixes or entry.mode & 0o111):
            with file.open("rb") as stream:
                header = stream.read(20)
            if header.startswith(b"\x7fELF") or file.suffix == ".node" or ".so" in file.suffixes:
                require(header.startswith(b"\x7fELF\x02\x01") and header[18:20] == b"\x3e\x00",
                        f"native file is not Linux x64 ELF: {name}")

    for name in ("server.js", "LICENSE", NOTICE, ".next/BUILD_ID", "scripts/plugin-loader.cjs"):
        require((destination / name).is_file(), f"missing standalone file: {name}")
    for name in (".next/static", "public", "node_modules", "core-plugins"):
        directory = destination / name
        require(directory.is_dir() and any(directory.iterdir()), f"missing standalone assets: {name}")


def measure(file):
    with tarfile.open(file, "r:gz") as archive:
        return sum(entry.size for entry in archive_members(archive).values() if entry.isfile())


def unpack(file, destination, size):
    require(not os.path.lexists(destination), f"destination already exists: {destination}")
    with tempfile.TemporaryDirectory(prefix=".learnharness-", dir=destination.parent) as scratch:
        staging = Path(scratch).resolve() / "standalone"
        staging.mkdir()
        with tarfile.open(file, "r:gz") as archive:
            members = archive_members(archive)
            require(size == sum(entry.size for entry in members.values() if entry.isfile()), "unpacked size mismatch")
            archive.extractall(staging, members=members.values(), filter="data")
        check_payload(staging, members)
        # GNU mv -T avoids merging directories. Check that --no-clobber moved
        # the tree, since a competing destination otherwise gives success.
        subprocess.run(["mv", "-T", "--no-clobber", staging, destination], check=True)
        require(not staging.exists(), f"destination already exists: {destination}")


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_assets(assets, tag, commit):
    tag_match = TAG_PATTERN.fullmatch(tag)
    require(tag_match and SHA_PATTERN.fullmatch(commit), "invalid release tag or expected commit")
    require({file.name for file in assets.iterdir()} == set(ASSETS), "unexpected release asset set")
    lines = (assets / SUMS).read_text().splitlines()
    expected = [f"{sha256(assets / name)}  {name}" for name in FILES]
    require(lines == expected, "SHA-256 mismatch")

    subprocess.run([
        "gh", "attestation", "verify", assets / SUMS, "--bundle", assets / PROVENANCE,
        "--repo", REPO, "--cert-identity", SIGNER,
        "--source-ref", "refs/heads/werft", "--source-digest", commit,
        "--signer-digest", commit, "--deny-self-hosted-runners",
    ], check=True, stdout=subprocess.DEVNULL)

    metadata = json.loads((assets / METADATA).read_text())
    require(metadata["release_tag"] == tag and metadata["fork_commit"] == commit, "release identity mismatch")
    require(metadata["upstream_tag"] == f"v{tag_match[1]}"
            and SHA_PATTERN.fullmatch(metadata["upstream_commit"]), "upstream identity mismatch")
    require(metadata["package_version"] == tag_match[1], "package version mismatch")
    require(metadata["os"] == "linux" and metadata["arch"] == "x64", "unsupported runtime target")
    require(re.fullmatch(r"[0-9]+\.[0-9]+", metadata["glibc_version"]), "invalid glibc build target")
    require(re.fullmatch(VERSION, metadata["node_version"])
            and type(metadata["node_abi"]) is int and metadata["node_abi"] > 0, "invalid Node runtime metadata")
    require(type(metadata["packed_bytes"]) is int and metadata["packed_bytes"] == (assets / RUNTIME).stat().st_size
            and type(metadata["unpacked_bytes"]) is int and metadata["unpacked_bytes"] > 0, "invalid archive sizes")

    with tarfile.open(assets / SOURCE, "r:gz") as source:
        require(source.pax_headers.get("comment") == commit, "source archive commit mismatch")
    return metadata


def download_release(tag, commit, directory):
    require(TAG_PATTERN.fullmatch(tag) and SHA_PATTERN.fullmatch(commit), "invalid release tag or expected commit")
    headers = ["--disable", "--proto", "=https", "--proto-redir", "=https", "--fail", "--silent", "--show-error",
               "--location", "--retry", "3", "--connect-timeout", "15", "--max-time", "600"]
    api = f"https://api.github.com/repos/{REPO}"
    release = json.loads(subprocess.check_output(["curl", *headers, f"{api}/releases/tags/{tag}"]))
    ref = json.loads(subprocess.check_output(["curl", *headers, f"{api}/git/ref/tags/{tag}"]))
    require(release["tag_name"] == tag and not release["draft"] and not release["prerelease"], "release is not published")
    require(ref["object"]["type"] == "commit" and ref["object"]["sha"] == commit, "release tag commit mismatch")
    listed_assets = release["assets"]
    require(sorted(asset["name"] for asset in listed_assets) == sorted(ASSETS), "unexpected release asset set")
    for asset in listed_assets:
        name, size = asset["name"], asset["size"]
        require(type(size) is int and size > 0 and asset["state"] == "uploaded", f"incomplete release asset: {name}")
        url = f"https://github.com/{REPO}/releases/download/{tag}/{name}"
        file = directory / name
        subprocess.run(["curl", *headers, "--max-filesize", str(size), "--output", file, url], check=True)
        require(file.stat().st_size == size, f"download size mismatch: {name}")


def verify_node(binary, metadata):
    version, abi = json.loads(subprocess.check_output([
        binary.absolute(), "-p", "JSON.stringify([process.versions.node, Number(process.versions.modules)])",
    ], env={key: value for key, value in os.environ.items() if key not in ("NODE_OPTIONS", "NODE_PATH")}, timeout=10))
    require(version == metadata["node_version"],
            f"Node version mismatch: expected {metadata['node_version']}, got {version}")
    require(abi == metadata["node_abi"],
            f"Node ABI mismatch: expected {metadata['node_abi']}, got {abi}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("expected_commit", help="Full fork commit from the trusted update candidate")
    parser.add_argument("destination", type=Path, help="New directory, with an existing parent")
    parser.add_argument("--node", required=True, type=Path, help="Path to the Node binary that will run the release")
    args = parser.parse_args()
    try:
        destination = args.destination.absolute()
        require(not os.path.lexists(destination), f"destination already exists: {destination}")
        with tempfile.TemporaryDirectory(prefix="learnharness-release-") as directory:
            assets = Path(directory)
            download_release(args.tag, args.expected_commit, assets)
            metadata = verify_assets(assets, args.tag, args.expected_commit)
            verify_node(args.node, metadata)
            unpack(assets / RUNTIME, destination, metadata["unpacked_bytes"])
        print(json.dumps(metadata, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Release refused: {error}\n")


if __name__ == "__main__":
    main()
