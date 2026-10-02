# Packages, languages and installation channels

**Registry status checked 2026-10-02:** [PyPI `envarpay` 0.1.0a10](https://pypi.org/project/envarpay/0.1.0a10/)
is published through the [verified release](https://github.com/EnvarAI/EnvarPay/actions/runs/36932006901).
Its clean registry installation and artifact hashes have been verified; wheel metadata,
runtime and CLI report the same version.
The npm package name is **`@envarai/envarpay`**, published in the `next` alpha channel.
The [initial 0.1.0-alpha.2 release](https://github.com/EnvarAI/EnvarPay/actions/runs/36956588838)
published the reviewed immutable tarball; its registry SHA256 matches the pinned
first-release artifact. Later versions use the same reviewed release workflow.

## What to install

| Need | Distribution | Current state |
|---|---|---|
| Run a wallet/payment gate with any MCP-capable agent | Python CLI, installed persistently with uv/pipx | Published on PyPI as 0.1.0a10 |
| Embed calls in a Python application | Python `envarpay` API | Implemented; install in a compatible isolated environment |
| Run the service without installing Python on the agent host | Standalone OCI container | Dockerfile and build checks added; no published GHCR image claimed |
| Use typed API calls from JS/TS | `@envarai/envarpay` wallet MCP client | Published on npm in the `next` alpha channel |
| Add OpenClaw/OpenCode-specific UI/hooks | Native npm plugin with its own manifest | Optional future adapter; ordinary SDK and MCP config are not native plugins |
| Connect Goose or another non-Python agent | Native MCP client/extension | Does not require a Rust-language EnvarPay SDK |
| Open your Agent's private text/voice/avatar/image/file interface | Python `envarlive` service | Published separately on PyPI; requires Node 24 and an existing reviewed Agent runtime |

The host language determines an **in-process library's** language, not the
language of a separate MCP service. MCP standardizes stdio and Streamable HTTP
messages across processes. Goose's official tutorial even builds its extension
in Python although Goose itself is written in Rust.

## Install from PyPI

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then use a
persistent tool environment pinned to the published version:

```sh
uv tool install --python 3.13 envarpay==0.1.0a10
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
uv tool install envarpay==0.1.0a10
# For a Python library environment:
python -m pip install envarpay==0.1.0a10
```

The npm client does not install Python behind an `npx` command.

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

The owner must authenticate the initial publication. npm currently permits 2FA
or a granular access token with bypass 2FA for direct publishing. After the package
exists, configure its GitHub Trusted Publisher as follows:

| Field | Value |
|---|---|
| npm package | `@envarai/envarpay` |
| GitHub organization | `EnvarAI` |
| Repository | `EnvarPay` |
| Workflow filename | `publish-npm.yml` |
| Environment | `npm` |

The manual workflow defaults to Trusted Publishing. For the first version only,
set `publish=true` and `bootstrap=true` on `main`, with a short-lived,
`@envarai`-scoped granular token saved as the GitHub Actions secret
`NPM_BOOTSTRAP_TOKEN`. Organization management permissions are unnecessary.
The bootstrap path accepts only `npm-v0.1.0-alpha.2` and verifies the tarball's
recorded SHA256 before publishing. The token is supplied only to its publish step.

After configuring the Trusted Publisher, remove the bootstrap secret and revoke
the token. Subsequent releases use OIDC with `bootstrap=false`; no long-lived npm
token is needed in the repository.

For fully native TS payment execution, use the official x402 TS SDKs and first
prove policy/ledger/nonce/recovery parity with Python. That is a separate implementation
and paid interoperability acceptance effort. Native OpenClaw/OpenCode plugins can
then be thin adapters to that client; Hermes and Goose can keep their standard MCP setup.

[Detailed research and official sources](../plans/distribution-and-adapters.zh-CN.md) ·
[Agent guides](integrations/index.md) · [Actual payment evidence](integrations/validation.md)
