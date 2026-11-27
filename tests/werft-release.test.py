"""Regression tests for the Linux release verifier (stdlib only)."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verifier", ROOT / "scripts/verify_werft_release.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def entry(name, data=b"test", *, link=None):
    info = tarfile.TarInfo(name)
    if link is not None:
        info.type = tarfile.SYMTYPE
        info.linkname = link
        return info, None
    info.size = len(data)
    return info, io.BytesIO(data)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.work = Path(scratch.name)
        self.artifact = self.work / verifier.RUNTIME
        self.destination = self.work / "installed"
        self.commit = "a" * 40
        self.tag = "werft-0.7.0.1"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.work, stderr=subprocess.DEVNULL, text=True).strip()

    def git_commit(self, message):
        self.git("add", "package.json")
        self.git("-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def make_archive(self, extra=()):
        entries = [
            entry("./server.js"),
            entry("./LICENSE"),
            entry("./.next/BUILD_ID"),
            entry("./.next/static/app.js"),
            entry("./scripts/plugin-loader.cjs"),
            entry("./public/logo.svg"),
            entry("./core-plugins/test/manifest.json"),
            entry("./node_modules/test/index.js"),
            entry("./node_modules/test/alias.js", link="./index.js"),
            *extra,
        ]
        with tarfile.open(self.artifact, "w:gz") as archive:
            for info, data in entries:
                archive.addfile(info, data)
        return sum(info.size for info, _ in entries if info.isfile())

    def test_preserves_dotfiles_and_relative_symlinks(self):
        self.make_archive()
        verifier.unpack(self.artifact, self.destination)
        self.assertTrue((self.destination / ".next/BUILD_ID").is_file())
        self.assertEqual((self.destination / "node_modules/test/alias.js").readlink(), Path("./index.js"))
        with self.assertRaisesRegex(ValueError, "destination already exists"):
            verifier.unpack(self.artifact, self.destination)

    def test_refuses_unsafe_entries_without_installing(self):
        for name, extra in [
            ("absolute path", entry("/outside")),
            ("escaping path", entry("../outside")),
            ("absolute link", entry("bin/unsafe", link="/etc")),
            ("escaping link", entry("bin/unsafe", link="../../outside")),
            ("link as parent", entry("node_modules/test/alias.js/child")),
        ]:
            with self.subTest(name=name):
                self.make_archive([extra])
                with self.assertRaises(ValueError):
                    verifier.unpack(self.artifact, self.destination)
                self.assertFalse(self.destination.exists())

    def test_foreign_native_file_never_reaches_destination(self):
        arm64 = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\xb7\x00"
        self.make_archive([entry("node_modules/test/native.node", arm64)])
        with self.assertRaisesRegex(ValueError, "not Linux x64 ELF"):
            verifier.unpack(self.artifact, self.destination)
        self.assertFalse(self.destination.exists())

    def make_release(self, node_version="26.13.1", *, packed_bytes=None, unpacked_bytes=None):
        actual_unpacked_bytes = self.make_archive()
        with tarfile.open(self.work / verifier.SOURCE, "w:gz", pax_headers={"comment": self.commit}) as source:
            source.addfile(*entry("learnharness/README.md"))
        (self.work / verifier.METADATA).write_text(json.dumps({
            "release_tag": self.tag, "fork_commit": self.commit, "upstream_tag": "v0.7.0",
            "upstream_commit": "c" * 40, "package_version": "0.7.0", "os": "linux", "arch": "x64",
            "glibc_version": "2.39",
            "node_version": node_version, "node_abi": 147,
            "packed_bytes": self.artifact.stat().st_size if packed_bytes is None else packed_bytes,
            "unpacked_bytes": actual_unpacked_bytes if unpacked_bytes is None else unpacked_bytes,
        }))
        (self.work / verifier.SUMS).write_text("".join(
            f"{verifier.sha256(self.work / name)}  {name}\n" for name in verifier.FILES
        ))
        (self.work / verifier.PROVENANCE).write_text("{}")

    def test_corrupted_archive_fails_before_attestation(self):
        self.make_release()
        with self.artifact.open("ab") as tar:
            tar.write(b"corruption")
        with patch.object(verifier.subprocess, "run") as attest:
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                verifier.verify_assets(self.work, self.tag, self.commit)
            attest.assert_not_called()

    def test_assets_attest_only_the_checksums_for_the_source_commit(self):
        self.make_release(node_version="28.2.1")
        with patch.object(verifier.subprocess, "run") as attest:
            metadata = verifier.verify_assets(self.work, self.tag, self.commit)
            subjects = [call.args[0][3].name for call in attest.call_args_list]
            self.assertEqual(subjects, [verifier.SUMS])
        self.assertEqual(metadata["fork_commit"], self.commit)
        self.assertEqual(metadata["node_version"], "28.2.1")

    def test_commit_and_signer_are_passed_to_the_attestation_verifier(self):
        self.make_release()
        wrong_commit = "b" * 40

        def reject_other_commit(command, **_):
            self.assertEqual(command[command.index("--cert-identity") + 1], verifier.SIGNER)
            self.assertIn(verifier.REPO, command)
            self.assertIn("--deny-self-hosted-runners", command)
            for flag in ("--signer-digest", "--source-digest"):
                self.assertEqual(command[command.index(flag) + 1], wrong_commit)
            raise subprocess.CalledProcessError(1, command)

        with patch.object(verifier.subprocess, "run", side_effect=reject_other_commit):
            with self.assertRaises(subprocess.CalledProcessError):
                verifier.verify_assets(self.work, self.tag, wrong_commit)
        self.assertFalse(self.destination.exists())

    def test_cli_checks_exact_node_version_and_abi_before_installing(self):
        self.make_release(packed_bytes=1, unpacked_bytes=2)
        node = self.work / "test node"
        argv = ["verify_werft_release.py", self.tag, self.commit, str(self.destination), "--node", str(node)]

        def download_fixture(_tag, _commit, destination):
            for asset in verifier.ASSETS:
                shutil.copyfile(self.work / asset, destination / asset)

        real_run = subprocess.run

        def run_locally(command, *args, **kwargs):
            if command[0] == "gh":
                return subprocess.CompletedProcess(command, 0)
            return real_run(command, *args, **kwargs)

        with patch.object(sys, "argv", argv), patch.object(verifier, "download_release", side_effect=download_fixture), \
                patch.object(verifier.subprocess, "run", side_effect=run_locally):
            for version, abi, error in [("26.13.0", 147, "version"), ("26.13.1", 146, "ABI")]:
                with self.subTest(error=error):
                    node.write_text(f"#!/bin/sh\nprintf '%s\\n' '[\"{version}\", {abi}]'\n")
                    node.chmod(0o755)
                    with self.assertRaises(SystemExit) as result, patch("sys.stderr", new_callable=io.StringIO) as stderr:
                        verifier.main()
                    self.assertEqual(result.exception.code, 1)
                    self.assertIn(f"Node {error} mismatch", stderr.getvalue())
                    self.assertFalse(self.destination.exists())

            node.write_text("#!/bin/sh\nprintf '%s\\n' '[\"26.13.1\", 147]'\n")
            with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                verifier.main()
            self.assertTrue((self.destination / "server.js").is_file())
            metadata = json.loads(stdout.getvalue())
            self.assertEqual((metadata["packed_bytes"], metadata["unpacked_bytes"]), (1, 2))

    def test_packager_records_archive_sizes(self):
        self.make_archive()
        standalone = self.work / ".next/standalone"
        standalone.parent.mkdir()
        verifier.unpack(self.artifact, standalone)
        (self.work / "LICENSE").write_text("fixture license")
        (self.work / "package.json").write_text('{"version": "0.7.0"}')
        (standalone / "package.json").write_text('{"version": "0.7.0"}')
        self.git("init")
        self.git("add", "LICENSE")
        commit = self.git_commit("Package fixture")
        node_version = subprocess.check_output(["node", "-p", "process.versions.node"], text=True).strip()

        assets = self.work / "assets"
        subprocess.run([sys.executable, ROOT / "scripts/package_werft_release.py", assets, self.destination],
                       cwd=self.work, check=True, env={
                           **os.environ, "RELEASE_TAG": self.tag, "GITHUB_SHA": commit, "UPSTREAM_TAG": "v0.7.0",
                           "UPSTREAM_COMMIT": self.commit, "NODE_VERSION": node_version,
                       })
        release = json.loads((assets / verifier.METADATA).read_text())
        self.assertEqual(release["packed_bytes"], (assets / verifier.RUNTIME).stat().st_size)
        self.assertEqual(release["unpacked_bytes"], sum(
            path.stat().st_size for path in self.destination.rglob("*") if not path.is_symlink() and path.is_file()
        ))

    def test_release_target_builds_the_run_commit_after_werft_advances(self):
        self.git("init")
        package = self.work / "package.json"
        package.write_text('{"version": "0.7.0"}')
        merged = self.git_commit("Merge the stable release")
        package.write_text('{"version": "0.8.0"}')
        run_commit = self.git_commit("Advance werft to a newer stable release")
        package.write_text('{"version": "0.9.0"}')
        future_commit = self.git_commit("Commit outside the run history")
        self.git("checkout", "--detach", run_commit)

        def target(event, merge_sha="", upstream_tag=""):
            return subprocess.run(["bash", ROOT / "scripts/werft-release-target.sh"], cwd=self.work,
                                  capture_output=True, text=True, env={
                                      **os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_SHA": run_commit,
                                      "MERGE_SHA": merge_sha, "UPSTREAM_TAG": upstream_tag,
                                  })

        for event, merge_sha, upstream_tag in [
            ("push", "", ""), ("workflow_dispatch", merged, "v0.7.0"),
            ("workflow_dispatch", merged, "v0.8.0"),
            ("workflow_dispatch", run_commit, ""),
        ]:
            with self.subTest(event=event, merge_sha=merge_sha):
                result = target(event, merge_sha, upstream_tag)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "v0.8.0")

        result = target("workflow_dispatch", future_commit, "v0.9.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("contained", result.stderr)


if __name__ == "__main__":
    unittest.main()
