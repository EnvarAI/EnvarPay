"""Bounded, metadata-only local inventory. Never reads model credentials or executes Skills."""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

try:
    import hermes_yaml as yaml
except ImportError:
    import yaml


def inventory(home):
    home = Path(home or os.environ.get("HERMES_HOME", "~/.hermes")).expanduser().resolve()
    config = yaml.safe_load((home / "config.yaml").read_text()) or {}
    roots = [home / "skills"]
    roots.extend(
        Path(os.path.expandvars(str(p))).expanduser().resolve()
        for p in config.get("skills", {}).get("external_dirs", [])
    )
    result, seen = [], set()
    for root in roots:
        if not root.is_dir():
            continue
        for folder, directories, files in os.walk(root, followlinks=False):
            directories[:] = sorted(
                d
                for d in directories
                if not d.startswith(".") and not (Path(folder) / d).is_symlink()
            )
            if len(Path(folder).relative_to(root).parts) > 10:
                directories[:] = []
                continue
            if "SKILL.md" not in files:
                continue
            entry = Path(folder) / "SKILL.md"
            if entry.is_symlink() or entry.stat().st_size > 48000:
                continue
            raw = entry.read_text()
            front = raw.split("---", 2)
            try:
                meta = (
                    yaml.safe_load(front[1]) if raw.startswith("---\n") and len(front) == 3 else {}
                )
            except Exception:
                continue
            name = (meta or {}).get("name")
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name)
                or name in seen
            ):
                continue
            seen.add(name)
            package, size, supported = [], 0, True
            for subfolder, dirs, names in os.walk(entry.parent, followlinks=False):
                for d in dirs[:]:
                    if (Path(subfolder) / d).is_symlink():
                        supported = False
                        dirs.remove(d)
                if len(Path(subfolder).relative_to(entry.parent).parts) > 10:
                    supported = False
                    dirs[:] = []
                for file_name in sorted(names):
                    file = Path(subfolder) / file_name
                    if file.is_symlink() or not file.is_file() or file.stat().st_size > 512 * 1024:
                        supported = False
                        continue
                    size += file.stat().st_size
                    if size > 1024 * 1024 or len(package) >= 128:
                        supported = False
                        break
                    if (file.suffix.lower() not in {".md", ".txt"} and file.name != "LICENSE"
                            and str(file.relative_to(entry.parent)) != ".clawhub/origin.json"):
                        supported = False
                    package.append(
                        [
                            str(file.relative_to(entry.parent)),
                            hashlib.sha256(file.read_bytes()).hexdigest(),
                        ]
                    )
            digest = hashlib.sha256(
                json.dumps(sorted(package), separators=(",", ":")).encode()
            ).hexdigest()
            result.append(
                {
                    "name": name,
                    "digest": digest,
                    "path": str(entry.parent),
                    "description": str((meta or {}).get("description", ""))[:500],
                    "supported": supported,
                }
            )
            directories[:] = []
            if len(result) >= 128:
                return result
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(inventory(sys.argv[1] if len(sys.argv) > 1 else None)))
    except Exception:
        print("Skill inventory unavailable", file=sys.stderr)
        sys.exit(1)
