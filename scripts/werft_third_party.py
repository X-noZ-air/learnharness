"""Generate the third-party notice from the standalone payload."""
import json
import os
from pathlib import Path


def metadata(path):
    if path.is_symlink():
        return {}
    try:
        value = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    return value if isinstance(value, dict) else {}


def string(value):
    return value if isinstance(value, str) and value.strip() else None


def component(standalone, path, package_name):
    installed = metadata(standalone / path / "package.json")
    repository = installed.get("repository")
    if not isinstance(repository, dict):
        repository = {"url": repository}
    license = installed.get("license")
    if isinstance(license, dict):
        license = license.get("type")
    fields = {
        "name": string(installed.get("name")),
        "version": string(installed.get("version")),
        "license": string(license),
        "source_repository": string(repository.get("url")),
        "source_directory": string(repository.get("directory")),
        "source_revision": string(installed.get("gitHead")),
        "package_distribution": string(installed.get("_resolved")),
        "path": path.as_posix(),
    }
    fields["missing_metadata"] = [
        field for field in ("name", "version", "license", "source_repository", "source_revision")
        if fields[field] is None
    ]
    fields["name"] = fields["name"] or package_name
    return fields


def package_name(path):
    if path.name.startswith((".", "@")):
        return None
    name, parent = path.name, path.parent
    if parent.name.startswith("@"):
        name = f"{parent.name}/{name}"
        parent = parent.parent
    if parent.name == "node_modules" or parent == Path("node_modules/next/dist/compiled"):
        return name
    return None


def generate_notice(standalone):
    components = []
    for directory, _, _ in os.walk(standalone):
        path = Path(directory).relative_to(standalone)
        name = package_name(path)
        if name:
            components.append(component(standalone, path, name))

    return json.dumps({
        "components": sorted(components, key=lambda item: item["path"]),
        "client_bundles": "Client bundles are built from dependencies pinned by this commit's lockfile, "
                          "which is included in the source archive.",
    }, indent=2) + "\n"
