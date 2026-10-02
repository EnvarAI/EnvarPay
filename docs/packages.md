# Packages, languages and installation channels

**Registry status checked 2026-10-02:** [PyPI `envarpay` 0.1.0a11](https://pypi.org/project/envarpay/0.1.0a11/)
is published through the [verified release](https://github.com/EnvarAI/EnvarPay/actions/runs/37025578570).
Its clean registry installation and artifact hashes have been verified; wheel metadata,
runtime and CLI report the same version.
The npm package name is **`@envarai/envarpay`**, published in the `next` alpha channel.
The [initial 0.1.0-alpha.2 release](https://github.com/EnvarAI/EnvarPay/actions/runs/36956588838)
published the reviewed immutable tarball; its registry SHA256 matches the pinned
first-release artifact. The [0.1.0-alpha.3 release](https://github.com/EnvarAI/EnvarPay/actions/runs/36967265580)
used GitHub OIDC Trusted Publishing with the bootstrap step skipped. Its public
registry tarball matches the exact CI artifact.

## What to install

| Need | Distribution | Current state |
|---|---|---|
| Run a wallet/payment gate with any MCP-capable agent | Python CLI, installed persistently with uv/pipx | Published on PyPI as 0.1.0a11 |
| Embed calls in a Python application | Python `envarpay` API | Implemented; install in a compatible isolated environment |
| Run the service without installing Python on the agent host | Standalone OCI container | Multi-platform build and explicit GHCR publication workflow; see [container release status](container.md) |
| Use typed API calls from JS/TS | `@envarai/envarpay` wallet MCP client | Published on npm in the `next` alpha channel |
| Add OpenClaw/OpenCode-specific UI/hooks | Native npm plugin with its own manifest | Optional future adapter; ordinary SDK and MCP config are not native plugins |
| Connect Goose or another non-Python agent | Native MCP client/extension | Does not require a Rust-language EnvarPay SDK |
| Open your Agent's private text/voice/avatar/image/file interface | Python `envarlive` service | Published separately on PyPI; requires Node >=24 with working node:sqlite and an existing reviewed Agent runtime |

The host language determines an **in-process library's** language, not the
language of a separate MCP service. MCP standardizes stdio and Streamable HTTP
messages across processes. Goose's official tutorial even builds its extension
in Python although Goose itself is written in Rust.

## Install from PyPI

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then use a
persistent tool environment pinned to the published version:

```sh
uv tool install --python 3.13 envarpay==0.1.0a11
envarpay --version
```

This installs from the public Python registry without cloning a checkout. Pinning
avoids silently changing payment code on the next install. The installer may
obtain a managed Python if that version is not already available.

Use `uv tool install` or pipx for long-lived CLI installs. `uvx` uses a temporary
cached environment; do not bind a persistent agent configuration to an interpreter
path that can disappear when the tool cache is cleaned. After moving/reinstalling,
regenerate connection snippets while keeping the original config/key/state paths.

For another Python version or a library environment:

```sh
uv tool install envarpay==0.1.0a11
# For a Python library environment:
python -m pip install envarpay==0.1.0a11
```

The npm client does not install Python behind an `npx` command.

## Standalone service image

The root Dockerfile builds only EnvarPay and its payment/MCP dependencies. It does
not bundle Hermes, OpenClaw or model credentials:

```sh
docker build -t envarpay:local .
docker run --rm --network none envarpay:local --version
```

The reviewed 0.1.0a11 image has been published to `ghcr.io/envarai/envarpay`,
and an authenticated pull passed an offline UID 10001 smoke check. It is still
private: organization policy disables the package's Public option. Use the local
build above or an authorized registry account until anonymous-pull verification
passes. See [the exact released digest and workflow](container.md#published-image-status).

The image defaults to UID/GID 10001 and a writable `/data` working directory.
Persist configs and state outside the image. Match bind-mount ownership with the
container UID (or an explicit `--user` matching the owner); never make key/token
files world-readable to work around permissions. Keep wallet keys/state exclusively
in the wallet's boundary and connect other agents through authenticated private MCP.
See [remote wallet isolation](directory-and-recovery.md#keep-signing-authority-outside-the-agent).

Native Windows key-file permission behavior is not validated. Use WSL or a
properly permissioned Linux container for the current CLI/service preview.

## PyPI publishing

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
The initial 0.1.0a6 publication completed on 2026-10-01 through the
[verified build/publish run](https://github.com/EnvarAI/EnvarPay/actions/runs/36804277559).

PyPI uses `README.pypi.md` with absolute documentation links and no Mermaid/image
rendering dependency. The repository README uses committed SVGs for its banner and
diagram, and GitHub Actions/Shields.io for badges. Test both surfaces
rather than assuming GitHub Markdown and PyPI render the same content.

## TypeScript client and npm publishing

The [TypeScript package](../packages/typescript) exposes `WalletClient.connect`,
`listPaidTools`, `callPaidTool`, `paymentStatus`, `recoverPayment` and `close` over
the existing wallet's authenticated Streamable HTTP MCP endpoint. It preserves
original request IDs, does not retry paid calls, and rejects redirects. Tests use
the actual Python wallet MCP adapter with a fake service, not blockchain payments.

With a wallet `[connection]`, `discoverAgents` and `getAgent` read Envar's catalog.
They do not add a seller to wallet policy. The wallet handles Envar reports and
the platform independently verifies payments. See the [Envar guide](envar.md) and
the [npm wallet setup](../packages/typescript/README.md).

The `TypeScript distribution` workflow tests Node 22/24 and Bun, then installs the
packed tarball into a separate consumer and checks its exported types. Publishing
requires an explicit manual run with a matching `npm-v<version>` tag. No push or
PR publishes. It uploads and publishes the same artifact, using npm provenance.

This package has the following GitHub Trusted Publisher connection:

| Field | Value |
|---|---|
| npm package | `@envarai/envarpay` |
| GitHub organization | `EnvarAI` |
| Repository | `EnvarPay` |
| Workflow filename | `publish-npm.yml` |
| Environment | `npm` |
| Allowed actions | Staged and direct publication; separate dist-tag management disabled |

The GitHub `npm` environment permits only branch `main`. To publish an existing
matching immutable release tag, run the workflow on `main` with `publish=true`
and `bootstrap=false`:

```sh
gh workflow run publish-npm.yml --repo EnvarAI/EnvarPay --ref main \
  -f 'tag=npm-v<VERSION>' -f publish=true -f bootstrap=false
```

The bootstrap path is reserved for the already-published first version
`npm-v0.1.0-alpha.2`, with its pinned tarball SHA256. It is not the release path
for subsequent versions. Its temporary token has been revoked and
`NPM_BOOTSTRAP_TOKEN` removed from GitHub Secrets. The package requires 2FA and
disallows bypass-2FA tokens; the configured OIDC publisher remains available.
OIDC releases need no npm token in GitHub Secrets.
After a successful workflow, verify the version and `next` tag in the public
registry and compare the tarball with the workflow artifact. npm may take several
minutes to make an accepted publication available.

For fully native TS payment execution, use the official x402 TS SDKs and first
prove policy/ledger/nonce/recovery parity with Python. That is a separate implementation
and paid interoperability acceptance effort. Native OpenClaw/OpenCode plugins can
then be thin adapters to that client; Hermes and Goose can keep their standard MCP setup.

[Detailed research and official sources](../plans/distribution-and-adapters.zh-CN.md) ·
[Agent guides](integrations/index.md) · [Actual payment evidence](integrations/validation.md)
