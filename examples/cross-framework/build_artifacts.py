"""Build public ARM Linux artifacts for later local-Docker acceptance, never payments."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "runtime-artifacts"
SOURCES = {
    item["name"]: item
    for item in json.loads((Path(__file__).parent / "sources.json").read_text())["sources"]
}


def run(*args: str, cwd: Path = ROOT, env: dict | None = None) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True)


def source(name: str) -> Path:
    info = SOURCES[name]
    path = ROOT / "runtime-sources" / name
    path.mkdir(parents=True, exist_ok=True)
    if not (path / ".git").exists():
        run("git", "init", str(path))
        run(
            "git",
            "remote",
            "add",
            "origin",
            f"https://github.com/{info['repository']}.git",
            cwd=path,
        )
        run("git", "fetch", "--depth", "1", "origin", info["sha"], cwd=path)
        run("git", "checkout", "--detach", "FETCH_HEAD", cwd=path)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()
    if sha != info["sha"]:
        raise RuntimeError("Source SHA mismatch")
    return path


def wheels(name: str, *requirements: str, env: dict | None = None) -> None:
    directory = OUTPUT / name
    directory.mkdir(parents=True, exist_ok=True)
    run(sys.executable, "-m", "pip", "wheel", "--wheel-dir", str(directory), *requirements, env=env)


def python_artifacts() -> None:
    wheels("wallet", str(ROOT))
    lc, lg = source("langchain"), source("langgraph")
    wheels(
        "langgraph",
        str(lc / "libs/core"),
        str(lc / "libs/langchain_v1") + "[mcp]",
        str(lc / "libs/partners/openai"),
        str(lg / "libs/langgraph"),
        str(lg / "libs/checkpoint"),
        str(lg / "libs/prebuilt"),
        str(lg / "libs/sdk-py"),
        "uvicorn",
    )
    pai = source("pydantic-ai")
    env = dict(
        os.environ,
        UV_DYNAMIC_VERSIONING_BYPASS="2.51.0+source." + SOURCES["pydantic-ai"]["sha"][:8],
    )
    wheels(
        "pydantic-ai",
        str(pai / "pydantic_graph"),
        str(pai / "pydantic_ai_slim") + "[mcp,openai]",
        "fastmcp>=4,<5",
        "uvicorn",
        env=env,
    )


def hermes_artifacts() -> None:
    path = source("hermes")
    requirements = OUTPUT / "hermes-requirements.txt"
    run(
        "uv",
        "export",
        "--frozen",
        "--no-dev",
        "--extra",
        "mcp",
        "--no-emit-project",
        "--no-hashes",
        "--output-file",
        str(requirements),
        cwd=path,
    )
    wheels("hermes", "-r", str(requirements), "setuptools==83.0.0", "wheel", "uvicorn")
    # Preserve the official source layout; Hermes explicitly disallows wheel distribution.
    archive = OUTPUT / "hermes-source.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for item in path.iterdir():
            if item.name != ".git":
                tar.add(item, arcname="hermes/" + item.name)
    # Standalone Python avoids requiring a matching host toolchain at local runtime.
    run("uv", "python", "install", "3.14.4")
    executable = subprocess.check_output(
        ["uv", "python", "find", "--managed-python", "3.14.4"], text=True
    ).strip()
    python_root = Path(executable).resolve().parent.parent
    with tarfile.open(OUTPUT / "python-3.14-linux-arm64.tar.gz", "w:gz") as tar:
        tar.add(python_root, arcname="python")


def native_artifacts(name: str) -> None:
    path = source(name)
    if name == "goose":
        run("sudo", "apt-get", "update")
        run(
            "sudo",
            "apt-get",
            "install",
            "-y",
            "cmake",
            "pkg-config",
            "libssl-dev",
            "libdbus-1-dev",
            "libclang-dev",
            "protobuf-compiler",
        )
        run("rustup", "toolchain", "install", "1.96.1", "--profile", "minimal")
        env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_PROFILE_RELEASE_DEBUG="0")
        run(
            "cargo",
            "build",
            "--locked",
            "--release",
            "-j",
            "2",
            "-p",
            "goose-cli",
            "--bin",
            "goose",
            "--no-default-features",
            "--features",
            "rustls-tls",
            cwd=path,
            env=env,
        )
        shutil.copy2(path / "target/release/goose", OUTPUT / "goose")
    elif name == "opencode":
        package = json.loads((path / "package.json").read_text())
        run("npm", "install", "-g", package["packageManager"])
        run("bun", "install", "--frozen-lockfile", cwd=path)
        run(
            "bun",
            "run",
            "script/build.ts",
            "--single",
            "--skip-install",
            "--skip-embed-web-ui",
            cwd=path / "packages/opencode",
            env=dict(
                os.environ,
                OPENCODE_VERSION=json.loads((path / "packages/opencode/package.json").read_text())[
                    "version"
                ],
            ),
        )
        shutil.copy2(
            path / "packages/opencode/dist/opencode-linux-arm64/bin/opencode", OUTPUT / "opencode"
        )
    else:
        run("docker", "build", "--progress=plain", "-t", "openclaw-pinned-source", ".", cwd=path)
        container = subprocess.check_output(
            ["docker", "create", "openclaw-pinned-source"], text=True
        ).strip()
        try:
            run("docker", "cp", f"{container}:/app", str(OUTPUT / "openclaw"))
            run("docker", "cp", f"{container}:/usr/local/bin/node", str(OUTPUT / "openclaw-node"))
        finally:
            run("docker", "rm", container)
        # Preserve pnpm's hidden directories, symlinks and executable modes.
        with tarfile.open(OUTPUT / "openclaw-runtime.tar.gz", "w:gz") as tar:
            tar.add(OUTPUT / "openclaw", arcname="app")
            tar.add(OUTPUT / "openclaw-node", arcname="node")
        shutil.rmtree(OUTPUT / "openclaw")
        (OUTPUT / "openclaw-node").unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", choices=["python", "hermes", "goose", "opencode", "openclaw"])
    args = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    if args.runtime == "python":
        python_artifacts()
    elif args.runtime == "hermes":
        hermes_artifacts()
    else:
        native_artifacts(args.runtime)
    shutil.copy2(Path(__file__).parent / "sources.json", OUTPUT / "sources.json")
    sums = {
        str(path.relative_to(OUTPUT)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in OUTPUT.rglob("*")
        if path.is_file()
    }
    (OUTPUT / "SHA256SUMS.json").write_text(json.dumps(sums, indent=2) + "\n")
    print("Build artifacts prepared. No agent run or payment acceptance was performed.")


if __name__ == "__main__":
    main()
