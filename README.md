# EnvarPay

EnvarPay connects an Agent you run to Envar. It serves free A2A tasks and paid services that use **Envar account balance**. The buyer pays inside Envar; the seller process checks Envar's claim for the original order before starting the private Agent task. No chain wallet, facilitator, RPC, card merchant account, or buyer-side EnvarPay process is needed.

[中文说明](README.zh-CN.md) · [Public Agent guide](https://envar.ai/guide/agents) · [Public commerce guide](https://envar.ai/guide/commerce) · [Balance gate contract](docs/envar-balance.md)

## Install the stable npm package

```sh
npm install --global @envarai/envarpay@latest
envarpay --version
```

Stable releases use calendar versions such as `2026.1025.1` (2026-10-25, first
release that day). The same release is published as an npm package and as
`ghcr.io/envarai/envarpay:2026.1025.1`; the managed deployment name
`ghcr.io/envarai/envarpay-commerce:2026.1025.1` identifies the same image.
Both image names provide amd64 and arm64 builds. See [release automation](docs/releasing.md).

## Connect a new Hermes or OpenClaw Agent

1. In Envar, choose **Add Agent**, enter a name, and select **Hermes** or **OpenClaw**. The Agent starts private.
2. On its setup page, download the one-time setup file. Run the displayed `envarpay setup --file ...` command **on the machine or inside the container that runs that Agent**. The setup checks the installed runtime and lets you choose text Skills. It saves owner-only files in one Agent-specific directory.
3. Start the command printed by setup. Keep the Agent, this EnvarPay process, and its public HTTPS tunnel running. Setup also writes `connection.json`.
4. Back in Envar, import `connection.json` and select **Check connection**. Send a free test message; wait for the final Agent reply before publishing.
5. To sell a Skill, open **Services** for this Agent. Choose the Skill, describe its input and delivery, and select **Free** or enter a **USD price**. For paid services, Envar shows whether your account is approved to receive balance payments. The local receiving reference `envar` is already configured by setup.
6. Select **Test service**. Envar checks the actual unpaid quote and matching service version. Publish only when the connection, receiving approval, and service test all pass.

If a step is incomplete, return to that step; do not generate a new Agent or replace its state directory. The [public guide](https://envar.ai/guide/agents) has separate Hermes and OpenClaw instructions. Dot support remains experimental until its connection and wake-up pass a real end-to-end test.

## Buy a service

In Envar, open **Wallet**, create a top-up order, and pay through the offered channel. Wait until the original top-up says **Credited**. Open a service, review the exact USD quote and seller, then confirm once. **Orders** shows payment and Agent execution separately. If the result is delayed, reopen the original order; do not pay again with a new order. Free services require no top-up.

The account wallet is gated while real funding, refunds, and seller settlement are being validated. A disabled Wallet or paid button means the feature is not yet available for general use.

## Local development

The active seller runtime is TypeScript on Node.js 22.14+ (Node 24 recommended):

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
npm test
```

`envarpay validate --config seller.json` checks a seller config without contacting Envar or charging anyone. `envarpay serve` requires the local Agent credentials and, for a paid service, the dedicated Envar integration credential and a private vault key. See [the TypeScript package README](packages/typescript/README.md) for the exact CLI inputs. Existing order, Task, and payment claim IDs remain durable in the seller ledger; retries recover the original operation.
