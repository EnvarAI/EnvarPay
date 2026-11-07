"""Negative checks for a metadata-only release; no network or signer imports."""
from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("legacy_release", Path(__file__).parents[1] / "release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

PROJECT = '''[build-system]
requires = ["hatchling>=1.27"]
build-backend = "hatchling.build"
[project]
name = "envarpay"
version = "0.1.0a11"
description = "Legacy baseline"
readme = "README.pypi.md"
requires-python = ">=3.11"
dependencies = ["mcp==1.28.1"]
[project.urls]
Documentation = "https://github.com/EnvarAI/EnvarPay/tree/main/docs"
[project.scripts]
envarpay = "envarpay.cli:main"
'''.encode()


class LegacyReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = release.read_manifest()
        self.readme = "Legacy Python maintenance\n"
        self.payload = {"envarpay/__init__.py": b"original executable bytes\n"}
        self.old_metadata = self.metadata(False)
        self.new_metadata = self.metadata(True)
        self.old_sdist = self.make_sdist(False)
        self.new_sdist = self.make_sdist(True)
        self.old_wheel = self.make_wheel(False)
        self.new_wheel = self.make_wheel(True)

    def metadata(self, changed):
        version = self.manifest["target_version"] if changed else self.manifest["source_version"]
        summary = self.manifest["summary"] if changed else "Legacy baseline"
        urls = ["Documentation, " + (self.manifest["documentation_url"] if changed else
                                   "https://github.com/EnvarAI/EnvarPay/tree/main/docs")]
        if changed:
            urls.append("Migration, " + self.manifest["migration_url"])
        fields = [
            "Metadata-Version: 2.5", "Name: envarpay", "Version: " + version,
            "Summary: " + summary, "Requires-Python: >=3.11", "Requires-Dist: mcp==1.28.1",
            "License-Expression: MIT", "Description-Content-Type: text/markdown",
            *["Project-URL: " + url for url in urls],
        ]
        return ("\n".join(fields) + "\n\n" + (self.readme if changed else "Original readme\n")).encode()

    def make_wheel(self, changed, payload=None, metadata=None, entrypoint=b"[console_scripts]\nenvarpay = envarpay.cli:main\n",
                   wheel=b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"):
        version = self.manifest["target_version"] if changed else self.manifest["source_version"]
        target = self.root / ("new.whl" if changed else "old.whl")
        prefix = f"envarpay-{version}.dist-info/"
        with zipfile.ZipFile(target, "w") as archive:
            for name, value in (payload if payload is not None else self.payload).items():
                archive.writestr(name, value)
            archive.writestr(prefix + "METADATA", metadata or (self.new_metadata if changed else self.old_metadata))
            archive.writestr(prefix + "WHEEL", wheel)
            archive.writestr(prefix + "entry_points.txt", entrypoint)
            archive.writestr(prefix + "licenses/LICENSE", b"Original MIT notice")
            archive.writestr(prefix + "RECORD", b"")
        return target

    def make_sdist(self, changed, extra=None):
        version = self.manifest["target_version"] if changed else self.manifest["source_version"]
        files = {
            "pyproject.toml": release.changed_project(PROJECT, self.manifest) if changed else PROJECT,
            "README.md": self.readme.encode() if changed else b"old",
            "README.pypi.md": self.readme.encode() if changed else b"old",
            "PKG-INFO": self.new_metadata if changed else self.old_metadata,
            "src/envarpay/__init__.py": self.payload["envarpay/__init__.py"],
            "LICENSE": b"Original MIT notice",
        }
        files.update(extra or {})
        target = self.root / ("new.tar.gz" if changed else "old.tar.gz")
        with tarfile.open(target, "w:gz") as archive:
            for name, value in files.items():
                member = tarfile.TarInfo(f"envarpay-{version}/{name}")
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
        return target

    def verify(self):
        return release.verify_release(self.old_sdist, self.old_wheel, self.new_sdist, self.new_wheel,
                                      self.manifest, self.readme)

    def test_metadata_only_release_preserves_payload(self):
        report = self.verify()
        self.assertTrue(report["installed_payload_unchanged"])
        self.assertEqual(report["installed_payload_files"], 1)

    def test_changed_executable_is_rejected(self):
        self.make_wheel(True, payload={"envarpay/__init__.py": b"changed code\n"})
        with self.assertRaisesRegex(ValueError, "payload changed"):
            self.verify()

    def test_changed_dependency_is_rejected(self):
        self.make_wheel(True, metadata=self.new_metadata.replace(b"mcp==1.28.1", b"mcp>=1"))
        with self.assertRaisesRegex(ValueError, "Runtime or license metadata changed"):
            self.verify()

    def test_changed_entry_point_is_rejected(self):
        self.make_wheel(True, entrypoint=b"[console_scripts]\nenvarpay = npm_installer:main\n")
        with self.assertRaisesRegex(ValueError, "entry points changed"):
            self.verify()

    def test_changed_python_compatibility_is_rejected(self):
        self.make_wheel(True, wheel=b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: cp313-none-any\n")
        with self.assertRaisesRegex(ValueError, "Wheel compatibility changed"):
            self.verify()

    def test_added_source_file_is_rejected(self):
        self.make_sdist(True, extra={"src/envarpay/new_wallet.py": b"new executable\n"})
        with self.assertRaisesRegex(ValueError, "inventory changed"):
            self.verify()

    def test_stale_sdist_metadata_is_rejected(self):
        self.make_sdist(True, extra={"PKG-INFO": self.old_metadata})
        with self.assertRaisesRegex(ValueError, "sdist and wheel metadata differ"):
            self.verify()

    def test_corrupted_cached_artifact_is_rejected(self):
        artifact = {"filename": "cached.whl", "sha256": "0" * 64, "url": "https://files.pythonhosted.org/unused"}
        (self.root / artifact["filename"]).write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            release.fetch_artifact(artifact, self.root)


if __name__ == "__main__":
    unittest.main()
