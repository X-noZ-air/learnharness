"""Make the third-party source supplement from the reviewed release inputs."""
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

from verify_werft_release import require, sha256

MANIFEST = Path(__file__).with_name("werft-source-dependencies.json")


def collect(destination):
    manifest = json.loads(MANIFEST.read_text())
    for package in manifest["packages"]:
        lock = Path("plugins", package["plugin"], "package-lock.json") if "plugin" in package else Path("package-lock.json")
        entry = json.loads(lock.read_text())["packages"]["node_modules/" + package["name"]]
        require(entry["version"] == package["version"],
                f"Refresh the source supplement for {package['name']} {entry['version']}")

    with tempfile.TemporaryDirectory(prefix="werft-dependency-sources-") as directory:
        sources = Path(directory)
        shutil.copyfile(MANIFEST, sources / MANIFEST.name)
        for name, (repo, commit) in manifest["repositories"].items():
            archive = sources / f"{name}-{commit}.tar.gz"
            download(f"https://codeload.github.com/{repo}/tar.gz/{commit}", archive)
            with tarfile.open(archive, "r:gz") as source:
                require(source.pax_headers.get("comment") == commit, f"unexpected source revision for {repo}")
        for name, (url, digest) in manifest["distribution_sources"].items():
            archive = sources / name
            download(url, archive)
            require(sha256(archive) == digest, f"dependency source digest mismatch: {name}")
            if not name.endswith(".patch"):
                with tarfile.open(archive, "r:*") as source:
                    require(source.next() is not None, f"empty dependency source archive: {name}")
        with tarfile.open(destination, "w:gz") as archive:
            archive.add(sources, arcname="dependency-sources")


def download(url, destination):
    subprocess.run([
        "curl", "--disable", "--fail", "--show-error", "--silent", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--retry", "3",
        "--connect-timeout", "15", "--max-time", "300", "--output", destination, url,
    ], check=True)
