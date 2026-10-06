"""Read owner-local Hermes settings through a private pipe; never calls a model."""

import json
import os
import shlex
import sys
from pathlib import Path

import yaml


def inspect(home):
    home = Path(home or os.environ.get("HERMES_HOME", "~/.hermes")).expanduser().resolve()
    config = yaml.safe_load((home / "config.yaml").read_text()) or {}
    model = config.get("model", {})
    if isinstance(model, str):
        model = {"default": model}
    provider = config.get("providers", {}).get(model.get("provider"), {})
    dotenv = {}
    if (home / ".env").exists():
        for line in (home / ".env").read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                dotenv[key.strip()] = value.strip().strip("\"'")
    key_file = None
    command = shlex.split(provider.get("key_cmd", ""))
    if len(command) == 2 and command[0] == "cat":
        key_file = str(Path(command[1]).expanduser().resolve())
    key = (
        provider.get("api_key")
        or provider.get("key")
        or dotenv.get("OPENAI_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    base = (
        provider.get("api")
        or provider.get("base_url")
        or model.get("base_url")
        or dotenv.get("OPENAI_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
    )
    if not model.get("default") or not base or not (key_file or key):
        raise ValueError("Model configuration unavailable")
    if key_file and (not Path(key_file).is_file() or not Path(key_file).read_text().strip()):
        raise ValueError("Model key unavailable")
    roots = [home / "skills"]
    roots.extend(
        Path(os.path.expandvars(str(p))).expanduser().resolve()
        for p in config.get("skills", {}).get("external_dirs", [])
    )
    skills = []
    seen = set()
    for root in roots:
        for entry in sorted(root.rglob("SKILL.md")) if root.is_dir() else []:
            if entry.is_symlink():
                continue
            raw = entry.read_text()
            front = raw.split("---", 2)
            meta = yaml.safe_load(front[1]) if raw.startswith("---\n") and len(front) == 3 else {}
            name = (meta or {}).get("name")
            if not isinstance(name, str) or name in seen:
                continue
            seen.add(name)
            files = []
            unsupported = False
            for file in entry.parent.rglob("*"):
                if file.is_symlink():
                    unsupported = True
                elif file.is_file():
                    if file.suffix.lower() not in {".md", ".txt"} and file.name != "LICENSE":
                        unsupported = True
                    files.append(str(file.relative_to(entry.parent)))
            skills.append(
                {
                    "name": name,
                    "path": str(entry.parent),
                    "description": str((meta or {}).get("description", ""))[:500],
                    "textPackage": not unsupported,
                    "files": len(files),
                }
            )
    return {
        "home": str(home),
        "python": sys.executable,
        "model": model["default"],
        "baseUrl": base,
        "apiKeyFile": key_file,
        "apiKey": None if key_file else key,
        "skills": skills,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(sys.argv[1] if len(sys.argv) > 1 else None)))
    except Exception:
        print(
            "Cannot read this Hermes model configuration. "
            "Configure an OpenAI-compatible model with a base URL and a local API key first.",
            file=sys.stderr,
        )
        sys.exit(1)
