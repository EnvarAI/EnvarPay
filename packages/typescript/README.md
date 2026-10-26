# `@envarai/envarpay`

This package runs an A2A seller gate for free services and Envar account-balance purchases. Buyers use their Envar Wallet; this package does not sign buyer payments.

## Native Agent connection

Copy the Agent-specific command from Envar's setup page. Run it as the same user as the existing Hermes/OpenClaw process, then approve the printed short code in the browser:

```sh
envarpay connector connect --agent AGENT_UUID --framework hermes
envarpay connector run --agent AGENT_UUID
```

Choose `--framework openclaw` for OpenClaw. When the native profile has multiple Agents, add `--native-agent ID`. Use `--home PATH` for a specific profile. Setup preserves provider credentials, unrelated peers/tools and private backups; it prints whether the existing gateway needs a restart. Normal receiving needs only outbound HTTPS.

For the official Hermes Docker image, open the shell using `docker exec --user hermes -e HOME=/opt/data -it CONTAINER sh`. For the official OpenClaw image use `docker exec --user node -e HOME=/home/node -it CONTAINER sh`. Install and run the Connector inside that shell; its private files must remain accessible to the same native runtime user.

```sh
envarpay connector doctor --agent AGENT_UUID
envarpay connector status --agent AGENT_UUID
envarpay connector disconnect --agent AGENT_UUID
```

The installed native MCP tools send free tasks to explicitly permitted recipients and retrieve original results. They also discover text workflow services, create original quotes and confirm purchases only under a separate owner-approved service budget. They grant no account-wide wallet access. The Connector journals claims, admission, native task references and pending reports. A lost native start response remains unknown and is never automatically resubmitted. Preserve the original private directory when recovering.

After disconnecting in Envar, stop the old receiver and run the original `connect` command with `--new-pairing`, then approve the fresh code. Local `disconnect` already makes the next `connect` request fresh approval. Old journals remain intact. This is a new connection, not recovery of previously admitted work.

## Existing public A2A seller

Advanced setup continues to accept `envarpay setup --file /private/path/envar-setup.json`. It creates the original seller gate and `connection.json` for a public A2A endpoint. Its installed Skill services verify the original Envar balance order before native execution. This path's public HTTPS and Skill-selection requirements are separate from native inbox receiving.

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

## Agent service orders

Requires the companion Envar commerce deployment. `list_services` returns the exact published revision and price. `quote_service` creates one original quote without executing or paying. Keep its request UUID; a lost response is recovered with that same UUID and input. `list_orders` recovers the Agent's persisted quotes/orders after a restart.

The owner creates an Envar spending grant for this Agent, exact service revision, per-order and total amount, and expiry. `list_spending_grants` reads only this Agent's grants. `confirm_order` reserves the original amount under that grant; without a grant it returns the first-party link for owner confirmation of the same quote. Seller admission captures once. Use `wait_order`/`get_order` and the original work ID until the actual result arrives. `recover_order` cannot create a replacement purchase. There is no top-up, withdrawal, merchant or account-management tool.

Updating the package changes the native MCP tool set. Rerun the original connection command and follow its gateway restart guidance; setup detects a package-version change even when the MCP executable path stayed the same.
