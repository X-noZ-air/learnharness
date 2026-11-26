"""Regression tests for the Linux release verifier (stdlib only)."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
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

    def make_archive(self, extra=()):
        with tarfile.open(self.artifact, "w:gz") as archive:
            for info, data in [
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
            ]:
                archive.addfile(info, data)

    def test_preserves_dotfiles_and_relative_symlinks(self):
        self.make_archive()
        verifier.unpack(self.artifact, self.destination, verifier.measure(self.artifact))
        self.assertTrue((self.destination / ".next/BUILD_ID").is_file())
        self.assertEqual((self.destination / "node_modules/test/alias.js").readlink(), Path("./index.js"))
        with self.assertRaisesRegex(ValueError, "destination already exists"):
            verifier.unpack(self.artifact, self.destination, verifier.measure(self.artifact))

    def test_refuses_unsafe_entries_without_installing(self):
        for name, extra in [
            ("absolute path", entry("/outside")),
            ("escaping path", entry("../outside")),
            ("absolute link", entry("bin/unsafe", link="/etc")),
            ("escaping link", entry("bin/unsafe", link="../../outside")),
            ("link as parent", entry("node_modules/test/alias.js/child")),
            ("profile", entry("data/settings.json")),
            ("credentials", entry("nested/auth.json")),
        ]:
            with self.subTest(name=name):
                self.make_archive([extra])
                with self.assertRaises(ValueError):
                    verifier.measure(self.artifact)
                self.assertFalse(self.destination.exists())

    def test_foreign_native_file_never_reaches_destination(self):
        arm64 = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\xb7\x00"
        self.make_archive([entry("node_modules/test/native.node", arm64)])
        with self.assertRaisesRegex(ValueError, "not Linux x64 ELF"):
            verifier.unpack(self.artifact, self.destination, verifier.measure(self.artifact))
        self.assertFalse(self.destination.exists())

    def make_release(self):
        self.make_archive()
        with tarfile.open(self.work / verifier.SOURCE, "w:gz", pax_headers={"comment": self.commit}) as source:
            source.addfile(*entry("learnharness/README.md"))
        (self.work / verifier.DEPENDENCY_SOURCES).write_bytes(b"synthetic vendor sources")
        (self.work / verifier.METADATA).write_text(json.dumps({
            "release_tag": self.tag, "fork_commit": self.commit, "upstream_tag": "v0.7.0",
            "upstream_commit": "c" * 40, "package_version": "0.7.0", "os": "linux", "arch": "x64",
            "glibc_version": "2.39",
            "node_version": "26.13.1", "node_abi": 147, "packed_bytes": self.artifact.stat().st_size,
            "unpacked_bytes": verifier.measure(self.artifact),
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

    def test_assets_bind_checksums_and_runtime_to_the_source_commit(self):
        self.make_release()
        with patch.object(verifier.subprocess, "run") as attest:
            metadata = verifier.verify_assets(self.work, self.tag, self.commit)
            subjects = [call.args[0][3].name for call in attest.call_args_list]
            self.assertEqual(subjects, [verifier.SUMS, verifier.RUNTIME])
        self.assertEqual(metadata["fork_commit"], self.commit)

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


if __name__ == "__main__":
    unittest.main()
