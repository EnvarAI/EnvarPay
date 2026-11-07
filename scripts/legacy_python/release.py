#!/usr/bin/env python3
"""Build a documentation-only maintenance release of the original Python package.

The active repository remains TypeScript. Legacy executable code is obtained
only from the immutable, hash-verified PyPI sdist and checked against its wheel.
This script never publishes, imports the legacy package or signs a payment.
"""
from __future__ import annotations

import argparse
import email
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "docs/legacy/python-release.json"
README_PATH = ROOT / "docs/legacy/PYPI_README.md"
SOURCE_METADATA_FILES = {"pyproject.toml", "README.md", "README.pypi.md", "PKG-INFO"}
MUTABLE_HEADERS = {"Version", "Summary", "Project-URL"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_manifest() -> dict:
    value = json.loads(MANIFEST_PATH.read_text())
    require(value["package"] == "envarpay", "Unexpected legacy package")
    require(value["source_version"] == "0.1.0a11", "Source version must remain the reviewed baseline")
    require(re.fullmatch(r"0\.1\.0a\d+", value["target_version"]) is not None, "Use a legacy alpha version")
    require(
        int(value["target_version"].split("a")[1]) > 11,
        "Maintenance version must follow the original alpha",
    )
    require(re.fullmatch(r"[a-f0-9]{40}", value["source_commit"]) is not None, "Invalid source commit")
    for kind in ("sdist", "wheel"):
        artifact = value[kind]
        parsed = urllib.parse.urlsplit(artifact["url"])
        require(parsed.scheme == "https" and parsed.hostname == "files.pythonhosted.org", "Use PyPI artifacts")
        require(Path(parsed.path).name == artifact["filename"], "Artifact filename mismatch")
        require(re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"]) is not None, "Invalid artifact digest")
    return value


def fetch_artifact(artifact: dict, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / artifact["filename"]
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(artifact["url"], timeout=60) as response:
            data = response.read(20 * 1024 * 1024 + 1)
        require(len(data) <= 20 * 1024 * 1024, "Legacy artifact is unexpectedly large")
        require(digest(data) == artifact["sha256"], "Original artifact digest mismatch")
        target.write_bytes(data)
    require(digest(data) == artifact["sha256"], "Cached artifact digest mismatch")
    return target


def source_files(archive: Path, version: str) -> dict[str, bytes]:
    result = {}
    root = f"envarpay-{version}"
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            parts = PurePosixPath(member.name).parts
            require(parts and parts[0] == root and ".." not in parts, "Unsafe source archive path")
            require(member.isfile() or member.isdir(), "Unsupported source archive member")
            if member.isdir():
                continue
            name = "/".join(parts[1:])
            require(name and name not in result, "Duplicate source archive member")
            stream = source.extractfile(member)
            require(stream is not None, "Missing source archive member")
            result[name] = stream.read()
    return result


def wheel_files(archive: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(archive) as source:
        names = source.namelist()
        require(len(names) == len(set(names)), "Duplicate wheel member")
        require(all(".." not in PurePosixPath(n).parts and not n.startswith("/") for n in names), "Unsafe wheel path")
        return {name: source.read(name) for name in names if not name.endswith("/")}


def wheel_parts(archive: Path, version: str) -> tuple[dict, email.message.Message, dict]:
    files = wheel_files(archive)
    prefix = f"envarpay-{version}.dist-info/"
    require(prefix + "METADATA" in files, "Wheel metadata directory does not match version")
    require(all(".dist-info/" not in n or n.startswith(prefix) for n in files), "Unexpected dist-info directory")
    payload = {n: b for n, b in files.items() if not n.startswith(prefix)}
    info = {n.removeprefix(prefix): b for n, b in files.items() if n.startswith(prefix)}
    metadata = email.message_from_bytes(info["METADATA"])
    return payload, metadata, info


def comparable_headers(message: email.message.Message) -> dict[str, list[str]]:
    return {
        name: message.get_all(name)
        for name in set(message.keys()) - MUTABLE_HEADERS
    }


def changed_project(original: bytes, manifest: dict) -> bytes:
    text = original.decode()
    old = tomllib.loads(text)
    require(old["project"]["version"] == manifest["source_version"], "Source project version mismatch")
    replacements = {
        f'version = "{manifest["source_version"]}"': f'version = "{manifest["target_version"]}"',
        f'description = {json.dumps(old["project"]["description"])}': f'description = {json.dumps(manifest["summary"])}',
        'Documentation = "https://github.com/EnvarAI/EnvarPay/tree/main/docs"':
            f'Documentation = "{manifest["documentation_url"]}"\nMigration = "{manifest["migration_url"]}"',
    }
    for before, after in replacements.items():
        require(text.count(before) == 1, "Original project metadata changed unexpectedly")
        text = text.replace(before, after)
    new = tomllib.loads(text)
    expected = json.loads(json.dumps(old))
    expected["project"]["version"] = manifest["target_version"]
    expected["project"]["description"] = manifest["summary"]
    expected["project"]["urls"]["Documentation"] = manifest["documentation_url"]
    expected["project"]["urls"]["Migration"] = manifest["migration_url"]
    require(new == expected, "Non-metadata pyproject content changed")
    return text.encode()


def verify_release(original_sdist: Path, original_wheel: Path, new_sdist: Path, new_wheel: Path,
                   manifest: dict, readme: str) -> dict:
    before, old_metadata, old_info = wheel_parts(original_wheel, manifest["source_version"])
    after, new_metadata, new_info = wheel_parts(new_wheel, manifest["target_version"])
    require(before == after, "Installed Python/package payload changed")
    require(comparable_headers(old_metadata) == comparable_headers(new_metadata), "Runtime or license metadata changed")
    require(old_info["entry_points.txt"] == new_info["entry_points.txt"], "CLI entry points changed")
    old_wheel_metadata = email.message_from_bytes(old_info["WHEEL"])
    new_wheel_metadata = email.message_from_bytes(new_info["WHEEL"])
    for field in set(old_wheel_metadata.keys()) | set(new_wheel_metadata.keys()):
        if field != "Generator":
            require(old_wheel_metadata.get_all(field) == new_wheel_metadata.get_all(field), "Wheel compatibility changed")
    old_nonmetadata = {n: b for n, b in old_info.items() if n not in {"METADATA", "RECORD", "WHEEL"}}
    new_nonmetadata = {n: b for n, b in new_info.items() if n not in {"METADATA", "RECORD", "WHEEL"}}
    require(old_nonmetadata == new_nonmetadata, "License notices or other installed metadata changed")
    require(new_metadata["Name"] == manifest["package"], "Package name changed")
    require(new_metadata["Version"] == manifest["target_version"], "Built version mismatch")
    require(new_metadata["Summary"] == manifest["summary"], "Legacy summary is missing")
    require(new_metadata.get_payload().strip() == readme.strip(), "PyPI legacy description mismatch")
    expected_urls = set(old_metadata.get_all("Project-URL", []))
    expected_urls.discard("Documentation, https://github.com/EnvarAI/EnvarPay/tree/main/docs")
    expected_urls.add("Documentation, " + manifest["documentation_url"])
    expected_urls.add("Migration, " + manifest["migration_url"])
    require(set(new_metadata.get_all("Project-URL", [])) == expected_urls, "Project URLs differ from the approved migration")
    old_source = source_files(original_sdist, manifest["source_version"])
    new_source = source_files(new_sdist, manifest["target_version"])
    require(old_source.keys() == new_source.keys(), "Source archive inventory changed")
    for name in old_source.keys() - SOURCE_METADATA_FILES:
        require(old_source[name] == new_source[name], "Legacy source changed: " + name)
    require(new_source["pyproject.toml"] == changed_project(old_source["pyproject.toml"], manifest), "Unexpected project metadata")
    require(new_source["README.pypi.md"].decode() == readme, "Source PyPI README mismatch")
    require(new_source["README.md"].decode() == readme, "Source README mismatch")
    sdist_metadata = email.message_from_bytes(new_source["PKG-INFO"])
    require(
        {k: sdist_metadata.get_all(k) for k in set(sdist_metadata.keys())}
        == {k: new_metadata.get_all(k) for k in set(new_metadata.keys())},
        "sdist and wheel metadata differ",
    )
    require(sdist_metadata.get_payload().strip() == readme.strip(), "sdist description mismatch")
    return {
        "source_version": manifest["source_version"],
        "target_version": manifest["target_version"],
        "source_commit": manifest["source_commit"],
        "installed_payload_unchanged": True,
        "runtime_dependencies_unchanged": True,
        "entry_points_unchanged": True,
        "license_notices_unchanged": True,
        "installed_payload_files": len(after),
        "source_inventory_files": len(new_source),
        "allowed_source_metadata_changes": sorted(SOURCE_METADATA_FILES),
        "payload_sha256": {name: digest(value) for name, value in sorted(after.items())},
    }


def build_release(output: Path, cache: Path | None = None) -> dict:
    manifest = read_manifest()
    readme = README_PATH.read_text()
    require("Legacy Python" in readme and manifest["source_commit"] in readme, "Use the reviewed legacy README")
    require(not output.exists() or not any(output.iterdir()), "Output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="envarpay-legacy-build-") as work:
        temporary = Path(work)
        originals = cache or temporary / "originals"
        original_sdist = fetch_artifact(manifest["sdist"], originals)
        original_wheel = fetch_artifact(manifest["wheel"], originals)
        files = source_files(original_sdist, manifest["source_version"])
        source = temporary / "source"
        for name, data in files.items():
            if name == "PKG-INFO":
                # The build backend regenerates metadata; copying the old file
                # would include both stale and generated PKG-INFO members.
                continue
            dest = source / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        (source / "pyproject.toml").write_bytes(changed_project(files["pyproject.toml"], manifest))
        (source / "README.md").write_text(readme)
        (source / "README.pypi.md").write_text(readme)
        # No private configuration or current TypeScript files enter this source tree.
        dist = output / "dist"
        env = dict(os.environ, SOURCE_DATE_EPOCH="315532800")
        subprocess.run(
            [sys.executable, "-m", "build", "--no-isolation", "--sdist", "--wheel", "--outdir", str(dist), str(source)],
            check=True, env=env,
        )
        new_sdist = dist / f'envarpay-{manifest["target_version"]}.tar.gz'
        new_wheel = dist / f'envarpay-{manifest["target_version"]}-py3-none-any.whl'
        report = verify_release(original_sdist, original_wheel, new_sdist, new_wheel, manifest, readme)
        subprocess.run([sys.executable, "-m", "twine", "check", "--strict", str(new_sdist), str(new_wheel)], check=True)
        report["original_artifacts"] = {
            k: {"filename": manifest[k]["filename"], "sha256": manifest[k]["sha256"]}
            for k in ("sdist", "wheel")
        }
        report["built_artifacts"] = {p.name: digest(p.read_bytes()) for p in (new_sdist, new_wheel)}
        try:
            report["recipe_revision"] = subprocess.check_output(
                ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True
            ).strip()
        except (OSError, subprocess.CalledProcessError):
            report["recipe_revision"] = "unavailable"
        recipe_paths = [Path(__file__).resolve(), MANIFEST_PATH, README_PATH,
                        ROOT / "scripts/legacy_python/requirements-build.txt"]
        report["recipe_files_sha256"] = {
            str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in recipe_paths
        }
        report["recipe_matches_commit"] = True
        for path in recipe_paths:
            committed = subprocess.run(
                ["git", "-C", str(ROOT), "show", "HEAD:" + str(path.relative_to(ROOT))],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            if committed.returncode or committed.stdout != path.read_bytes():
                report["recipe_matches_commit"] = False
        (output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
        return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, help="Optional directory containing the exact hash-pinned originals")
    args = parser.parse_args()
    result = build_release(args.output_dir.resolve(), args.cache_dir.resolve() if args.cache_dir else None)
    print(json.dumps({key: value for key, value in result.items() if key != "payload_sha256"}, indent=2))


if __name__ == "__main__":
    main()
