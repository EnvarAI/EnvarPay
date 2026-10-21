# `@envarai/envarpay`

This package runs an A2A seller gate for free services and Envar account-balance purchases. Buyers use their Envar Wallet; this package does not sign buyer payments.

## Recommended setup

Use the Agent-specific setup file downloaded from Envar:

```sh
envarpay setup --file /private/path/envar-setup.json
```

Follow the terminal prompts to select a Hermes or OpenClaw runtime and its text Skills. Setup creates an owner-only directory containing `seller.json`, `credentials.json`, `envar.json`, `envar.token`, `vault.key`, `connection.json`, and `start.mjs`. Run the printed `node .../start.mjs` command, import `connection.json` in Envar, and select **Check connection**. The public [Agent guide](https://envar.ai/guide/agents) gives the platform-specific steps and the test message to send.

The generated seller starts with free services and a local balance receiving reference of `envar`. A paid service becomes available only after Envar approves this seller account and the service editor verifies the actual unpaid USD quote. In Envar, choose a Skill, enter its USD price, select **Test service**, then **Publish**. There is no separate payment setup command.

## Manual seller commands

```sh
envarpay init --directory /private/envarpay
envarpay validate --config /private/envarpay/seller.json
envarpay card --config /private/envarpay/seller.json --service SERVICE --offer OFFER --origin https://seller.example
envarpay serve --config /private/envarpay/seller.json --credentials /private/envarpay/credentials.json --state /private/envarpay/seller.sqlite3 --origin https://seller.example --envar-config /private/envarpay/envar.json --envar-credentials /private/envarpay/envar.token
envarpay inspect --state /private/envarpay/seller.sqlite3
```

`init` creates a sample seller config and vault key; it does not authorize paid work. Put secrets only in owner-only files (`chmod 600`), keep the state directory private, and use one running process per ledger. The runtime verifies the configured service revision, original A2A Task and one captured Envar balance claim before calling the private Agent. It stores the original claim and Task handles so a lost response can be recovered without charging twice.

The seller configuration schema is [`schemas/envarpay.config.schema.json`](schemas/envarpay.config.schema.json). Paid amounts are integer **micro-USD** (`100000` = USD 0.10); free offers have no payment profile. An `envar_balance` profile contains only `{ "adapter": "envar_balance", "currency": "usd", "accountRef": "envar" }`. The private Envar policy must allow that exact account reference.

For development, run `npm ci --ignore-scripts`, `npm run build`, and `npm test` from this directory. Node.js 22.14+ is required; Node 24 is recommended.
