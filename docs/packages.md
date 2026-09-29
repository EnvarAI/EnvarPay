# Packages, languages and installation channels

**Registry status checked 2026-09-30:** PyPI `envarpay` and npm `envarpay` both
returned 404. GitHub prereleases exist; they are not PyPI/npm publications.
This distribution candidate is 0.1.0a6 and includes the 0.1.0a5 security baseline.
At the initial registry check, the published GitHub prerelease was 0.1.0a3.
The newer setup commands require the matching source version.

## What to install

| Need | Distribution | Current state |
|---|---|---|
| Run a wallet/payment gate with any MCP-capable agent | Python CLI, installed persistently with uv/pipx | Source-installable; PyPI publishing preparation added |
| Embed calls in a Python application | Python `envarpay` API | Implemented; install in a compatible isolated environment |
| Run the service without installing Python on the agent host | Standalone OCI container | Dockerfile and build checks added; no published GHCR image claimed |
| Use typed API calls from JS/TS | A genuine npm TypeScript client | Proposed; not implemented/published |
| Add OpenClaw/OpenCode-specific UI/hooks | Native npm plugin with its own manifest | Optional future adapter; ordinary SDK and MCP config are not native plugins |
| Connect Goose or another non-Python agent | Native MCP client/extension | Does not require a Rust-language EnvarPay SDK |

The host language determines an **in-process library's** language, not the
language of a separate MCP service. MCP standardizes stdio and Streamable HTTP
messages across processes. Goose's official tutorial even builds its extension
in Python although Goose itself is written in Rust.

## Install the current preview without manual cloning

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then use a
persistent tool environment pinned to the reviewed onboarding commit:

```sh
uv tool install --python 3.13 'git+https://github.com/EnvarAI/EnvarPay.git@f794729106d1c80543e179c395899c497c6e01f0'
envarpay --version
```

This is a **Git source install**, not a registry install. It gives the 0.1.0a5 CLI
without manually cloning a checkout or activating a venv. Pinning avoids silently
changing payment code on the next install. The installer may obtain a managed
Python if that requested version is not already available.

Use `uv tool install` or pipx for long-lived CLI installs. `uvx` uses a temporary
cached environment; do not bind a persistent agent configuration to an interpreter
path that can disappear when the tool cache is cleaned. After moving/reinstalling,
regenerate connection snippets while keeping the original config/key/state paths.

After a real PyPI publication, the intended commands become:

```sh
uv tool install envarpay==0.1.0a6
# For a Python library environment:
python -m pip install envarpay==0.1.0a6
```

These registry commands are **not available yet**. Do not substitute a different
project or publish an empty npm launcher to make an installation badge look complete.

## Standalone service image

The root Dockerfile builds only EnvarPay and its payment/MCP dependencies. It does
not bundle Hermes, OpenClaw or model credentials:

```sh
docker build -t envarpay:local .
docker run --rm --network none envarpay:local --version
```

This is a local build, not `docker pull` from a published registry. The intended
future image is `ghcr.io/envarai/envarpay`, subject to publication and anonymous-pull
verification. CI builds on amd64 and arm64 without publishing.

The image defaults to UID/GID 10001 and a writable `/data` working directory.
Persist configs and state outside the image. Match bind-mount ownership with the
container UID (or an explicit `--user` matching the owner); never make key/token
files world-readable to work around permissions. Keep wallet keys/state exclusively
in the wallet's boundary and connect other agents through authenticated private MCP.
See [remote wallet isolation](directory-and-recovery.md#keep-signing-authority-outside-the-agent).

Native Windows key-file permission behavior is not validated. Use WSL or a
properly permissioned Linux container for the current CLI/service preview.

## PyPI release preparation

The `Python distribution` workflow builds and checks wheel/sdist on relevant PRs.
Manual runs require an existing version-matched release tag. **Publishing defaults
to false**. A publish job only runs after an explicit manual choice and uses the
same built artifacts with PyPI Trusted Publishing.

The PyPI project owner must configure a pending/existing Trusted Publisher:

| Field | Value |
|---|---|
| PyPI project | `envarpay` |
| GitHub owner | `EnvarAI` |
| Repository | `EnvarPay` |
| Workflow filename | `publish-python.yml` |
| GitHub environment | `pypi` |

Protect the GitHub `pypi` environment with the intended release reviewers. This
configuration is external account authority, not something a GitHub repo token
can automatically grant. No wallet private key or long-lived PyPI token is needed.
The workflow has not been dispatched to publish by this change.

PyPI uses `README.pypi.md` with absolute documentation links and no Mermaid/image
rendering dependency. The repository README uses committed SVGs. Test both surfaces
rather than assuming GitHub Markdown and PyPI render the same content.

## TypeScript and native plugin direction

The next npm package should expose a real typed API over the existing wallet's
standard MCP endpoint: discover allowed tools, call a paid capability, inspect
status and recover the original operation. It should not install Python behind
an `npx` command or claim to be an in-process signer/server when it is a client.

For fully native TS payment execution, use the official x402 TS SDKs and first
prove policy/ledger/nonce/recovery parity with Python. That is a separate implementation
and paid interoperability acceptance effort. Native OpenClaw/OpenCode plugins can
then be thin adapters to that client; Hermes and Goose can keep their standard MCP setup.

[Detailed research and official sources](../plans/distribution-and-adapters.zh-CN.md) ·
[Agent guides](integrations/index.md) · [Actual payment evidence](integrations/validation.md)
