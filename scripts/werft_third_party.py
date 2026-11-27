"""Generate the release's third-party notice using local build metadata."""
import json
import os
from pathlib import Path


def metadata(path):
    try:
        value = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    return value if isinstance(value, dict) else {}


def first_string(*values):
    return next((value for value in values if isinstance(value, str) and value.strip()), None)


def component(name, installed, locked, scope):
    repository = installed.get("repository")
    directory = None
    if isinstance(repository, dict):
        directory = first_string(repository.get("directory"))
        repository = repository.get("url")
    license = installed.get("license")
    if isinstance(license, dict):
        license = license.get("type")
    fields = {
        "name": first_string(installed.get("name"), locked.get("name"), name),
        "version": first_string(installed.get("version"), locked.get("version")),
        "license": first_string(license, locked.get("license")),
        "source_repository": first_string(repository),
        "source_directory": directory,
        "source_revision": first_string(installed.get("gitHead")),
        "package_distribution": first_string(locked.get("resolved"), installed.get("_resolved")),
        "scope": scope,
    }
    fields["missing_metadata"] = [
        field for field in ("version", "license", "source_repository", "source_revision")
        if fields[field] is None
    ]
    return fields


def package_name(path):
    return path.rsplit("node_modules/", 1)[-1]


def package_root(path):
    if "node_modules/" not in path:
        return False
    name = package_name(path)
    parts = name.split("/")
    return not name.startswith(".") and len(parts) == (2 if name.startswith("@") else 1)


def lock_packages(root):
    packages = metadata(root / "package-lock.json").get("packages")
    if not isinstance(packages, dict):
        return {}
    return {
        path: entry for path, entry in packages.items()
        if path.startswith("node_modules/") and isinstance(entry, dict)
    }


def generate_notice(root, standalone):
    components = []
    locked = lock_packages(root)
    shipped = set()

    for directory, directories, files in os.walk(standalone / "node_modules"):
        relative = Path(directory).relative_to(standalone).as_posix()
        if package_root(relative):
            shipped.add(relative)
        elif relative.startswith("node_modules/next/dist/compiled/") and "package.json" in files:
            installed = metadata(Path(directory) / "package.json")
            if installed.get("name"):
                components.append(component(installed["name"], installed, {}, "vendored by Next.js"))
        for name in directories:
            linked = Path(directory, name)
            if linked.is_symlink():
                linked_path = linked.relative_to(standalone).as_posix()
                if package_root(linked_path):
                    shipped.add(linked_path)

    for path in sorted(shipped | set(locked)):
        entry = locked.get(path, {})
        installed_file = root / path / "package.json"
        if path in shipped:
            packaged = metadata(standalone / path / "package.json")
            installed = {**metadata(installed_file), **packaged}
            scope = "standalone node_modules"
        elif not entry.get("dev") and installed_file.parent.is_dir():
            installed = metadata(installed_file)
            scope = "installed application production dependency"
        else:
            continue
        components.append(component(package_name(path), installed, entry, scope))
        if path in shipped and package_name(path).startswith("@img/sharp-libvips-"):
            versions_file = "versions.json"
            versions = metadata(standalone / path / versions_file) or metadata(root / path / versions_file)
            for name, version in sorted(versions.items()):
                components.append(component(name, {"version": version}, {}, f"bundled by {package_name(path)}"))

    for plugin in sorted((standalone / "core-plugins").iterdir()):
        if not plugin.is_dir():
            continue
        project = root / "plugins" / plugin.name
        for path, entry in sorted(lock_packages(project).items()):
            installed_file = project / path / "package.json"
            if not entry.get("dev") and installed_file.parent.is_dir():
                components.append(component(package_name(path), metadata(installed_file), entry,
                                            f"installed {plugin.name} production dependency"))

    for name, license, pattern in (
        ("Computer Modern Unicode fonts", "OFL-1.1", "public/fonts/OFL.txt"),
        ("BaKoMa fonts", "BaKoMa Fonts Licence", "core-plugins/*/assets/fonts/bakoma/LICENCE"),
    ):
        if any(standalone.glob(pattern)):
            components.append(component(name, {"license": license}, {}, "bundled fonts"))

    attribution = [
        path.relative_to(standalone).as_posix()
        for pattern in ("public/fonts/OFL.txt", "core-plugins/*/THIRD-PARTY*", "core-plugins/*/licenses/*",
                        "core-plugins/*/FSRS-LICENSE.txt", "src/agent/image-processing/LICENSE")
        for path in sorted(standalone.glob(pattern))
        if path.is_file()
    ]
    return json.dumps({
        "components": sorted(components, key=lambda item: (item["scope"], item["name"], item["version"] or "")),
        "bundled_attribution_files": attribution,
    }, indent=2) + "\n"
