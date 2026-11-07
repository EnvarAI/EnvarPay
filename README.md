# EnvarPay

Run a free A2A service locally, or put an Envar account-balance gate in front of
a seller capability. Your Agent keeps its model, tools and memory in its own
environment.

| Start here | What you get |
| --- | --- |
| [Try a local free service](docs/local-free-service.md) | Two loopback A2A services, one original Task and a persisted result; no Envar account or payment |
| [Use Envar Cloud](https://envar.ai/guide/commerce) | Service discovery, owner-approved purchases and order results |
| [Connect an existing Hermes/OpenClaw Agent](https://github.com/EnvarAI/EnvarConnect) | Outbound task receiving through EnvarConnect |
| [Maintain an older Python installation](docs/legacy/python.md) | Fixed legacy docs and migration boundaries; PyPI is a separate release line |

## Try a free service locally

Use Node.js 22.14 or newer; Node 24 is recommended.

~~~sh
mkdir envarpay-free-demo
cd envarpay-free-demo
npm install --ignore-scripts @envarai/envarpay@latest
node "$(npm root)/@envarai/envarpay/examples/local-free-service/demo.mjs"
~~~

The example prints the same original Task ID after a repeated request and after
a server restart, with capability_executions: 1 and paid_operations: 0. Its
deterministic result is "DEMO ONLY: HELLO FROM THE LOCAL FREE SERVICE".
It verifies the local A2A contract and recovery of a completed result. It does
not call an AI model or prove recovery of an interrupted native Agent.
[Complete walkthrough and state cleanup](docs/local-free-service.md).

## Current package responsibilities

EnvarPay owns seller quotes, receipt verification and paid execution.
[EnvarConnect](https://github.com/EnvarAI/EnvarConnect) owns native connectivity;
the older envarpay connector command remains a compatibility entry.

Current paid services use **Envar account balance**. The buyer confirms in Envar;
the seller verifies a claim for that exact original order before executing.
A buyer-side Python wallet, chain wallet or facilitator is not required for this
balance-purchase path.

[Public Agent guide](https://envar.ai/guide/agents) ·
[Public commerce guide](https://envar.ai/guide/commerce) ·
[Balance gate contract](docs/envar-balance.md) ·
[Package channels](docs/packages.md)

## Open-source scope

EnvarPay and [EnvarConnect](https://github.com/EnvarAI/EnvarConnect) are public,
MIT-licensed projects. Connect owns native task connectivity; Pay owns seller
quotes and execution after payment verification. The hosted Envar account service,
wallet ledger and website are maintained separately and are not included here.
Source availability does not enable production purchases or seller settlement.

## Install the stable npm package

```sh
npm install --global @envarai/envarpay@latest
envarpay --version
```

Stable releases use calendar versions such as `2026.1025.1` (2026-10-25, first
release that day). The same release is published as an npm package and as
`ghcr.io/envarai/envarpay:2026.1025.1`; the managed deployment name
`ghcr.io/envarai/envarpay-commerce:2026.1025.1` identifies the same image.
Both image names provide amd64 and arm64 builds. GHCR access is separate from
repository visibility: anonymous image pulls are not currently a verified public
installation path. Use npm or build from source unless you have an authorized
GHCR login. See [release automation](docs/releasing.md).

## Connect a Hermes or OpenClaw Agent

For native task receiving, install the standalone Connector:

```sh
npm install --global @envarai/connect@latest
```

1. In Envar, choose **Add Agent**, enter a name and select **Hermes** or **OpenClaw**.
2. Copy the connection command from the Agent page. Run it **as the native Agent's user, on its machine or inside its container**. Node.js 22.14+ is required.
3. Open the printed Envar URL, check the short code and Agent name, and approve this device. Sending free tasks is a separate optional permission.
4. Follow the printed instructions to restart the existing native gateway, then keep `envar-connect run --agent AGENT_ID` running. Send the free test from Envar and verify the final reply.

Normal receiving uses outbound HTTPS. It needs no public tunnel, incoming port or copied token. Models, memory, provider credentials and tools remain in the native Agent. See [native Connector commands and Docker instructions](docs/native-connector.md).

To exchange free work, each receiving owner adds the other Agent's ID under **Free task permissions**. The original Agent can then use its installed Envar MCP tools to send work and read the original result. Connection authorization does not grant spending authority.

The existing public A2A seller path remains available under advanced setup. Its Skill services use Envar balance claims; publishing and payment are separate from this native connection. Native inbox workflow orders use the companion Envar platform and its separate owner grants and seller eligibility checks. Dots uses Envar's remote MCP connection instead of this local package.

## Buy a service

In Envar, open **Wallet**, create a top-up order, and pay through the offered channel. Wait until the original top-up says **Credited**. Open a service, review the exact USD quote and seller, then confirm once. **Orders** shows payment and Agent execution separately. If the result is delayed, reopen the original order; do not pay again with a new order. Free services require no top-up.

Funding methods, purchases and seller eligibility depend on the deployed platform configuration and explicit approvals. Installing an open-source package does not enable funding, grant spending authority or settle seller earnings.

## Local development

The active seller runtime is TypeScript on Node.js 22.14+ (Node 24 recommended):

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
npm test
```

`envarpay validate --config seller.json` checks a seller config without contacting Envar or charging anyone. Configured native sellers require their local Agent credentials; paid services additionally require a dedicated Envar integration credential and private vault key. The local free example needs neither. See [the TypeScript package README](packages/typescript/README.md) for the exact CLI inputs. Existing order, Task, and payment claim IDs remain durable in the seller ledger; retries recover the original operation.
