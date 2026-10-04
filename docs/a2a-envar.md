# Optional Envar connection for A2A commerce

EnvarPay can sell and buy A2A services without an Envar account or network request. The optional `EnvarIntegration` module synchronizes seller configuration and sends minimal observations to an Envar directory. It never signs payments, changes buyer budgets or treats an acknowledgment as payment evidence.

This document describes the Node 22+ module API. CLI polling and runtime application must explicitly wire it in; importing the portable commerce contracts does not start it.

## Local grants and credentials

Use the policy in [`envar-integration-policy.json`](../packages/typescript/examples/envar-integration-policy.json). Replace the illustrative IDs, upstream origins and receiving identity before enabling it. `enabled: true` opts into the connection. `acceptUpdates: true` separately grants configuration changes within the local allowlist. With updates disabled, `pullCandidates()` returns no candidates and sends no request.

The platform origin must be a single HTTPS origin without a path, embedded credential, query or fragment. All three management paths are fixed by the module. Requests use `redirect: error`, omit cookies, have a timeout and cap response bodies. A returned redirect or a different final URL is also rejected. The dedicated Agent machine token is read by a callback, sent only to that origin and never written into the integration database.

The authenticated candidates response must include the configured platform `agent_id`. The candidate's `config.agent.id` is a separate, locally chosen runtime identity. A display name or local identifier does not grant platform ownership.

Private directories must already be owner-only or be created as `0700`; configuration files and SQLite files are `0600`. Use a dedicated directory, not a shared project root or `/tmp` itself. A companion SQLite exclusive lock prevents two processes from owning the same integration directory and releases automatically when the process exits.

## Application flow

```ts
import { readFileSync } from "node:fs";
import { EnvarIntegration } from "./dist/commerce/envar.js";
import { digest } from "./dist/commerce/config.js";

const integration = new EnvarIntegration({
  policy: localPolicy,
  stateDirectory: "/private/envarpay/envar-state",
  configDirectory: "/private/envarpay/envar-configs",
  token: () => readFileSync("/private/envarpay/envar.token", "utf8").trim(),
});

for (const candidate of await integration.pullCandidates()) {
  await integration.applyCandidate(candidate, async (accepted) => {
    // Your runtime manager must apply this revision to its active routes,
    // preserve other services and historical orders, and persist its catalog.
    // This callback must be idempotent for the same revision and digest.
    await runtimeManager.applyServiceRevision(accepted.config);
    const service = accepted.config.services[0];
    const stored = store
      .catalogHistory()
      .find(
        (entry) =>
          entry.service.id === service.id &&
          entry.service.revision === service.revision,
      );
    if (
      !stored ||
      runtimeManager.activeServiceDigest(service.id) !== accepted.digest
    ) {
      throw new Error("Runtime application has not completed");
    }
    return {
      digest: accepted.digest,
      services: [
        { id: service.id, revision: service.revision, digest: digest(stored) },
      ],
    };
  });
}
await integration.flush();
```

`runtimeManager` in this example is an application-owned interface, not an exported EnvarPay API. It must really update active routes and call the runtime's durable catalog registration before returning proof. Merely computing the expected digest does not apply a configuration. `envarServiceProofs(config)` exposes expected fingerprints for comparison and tests; it is not execution evidence.

The module validates the actual config with `loadCommerceConfig`, checks its JCS digest against the candidate and publication, checks allowed service IDs, upstream origins, USDC network/asset/payee/facilitator origins and merchant account references. It rejects conflicting historical versions and prevents applying an older revision over a newer applied one. A pull containing several valid pending revisions selects the newest per service.

Before applying, the exact candidate is written to an immutable version file. The callback receives a clone. Only matching application proof permits writing the current-service file, marking the revision applied and enqueuing the acknowledgment. A failed callback or mismatch never acknowledges application. If a process dies after application but before acknowledgment, restart with the same private directory: retry the same candidate idempotently, then deliver its durable event. Config sync itself never executes a purchased task.

Each candidate config contains exactly one service. The runtime manager must merge it into its active catalog; it must not replace the entire multi-service configuration with that single service. Current files are per-service for this reason. Changing runtime credentials, signing policy, allowed payees or merchant keys remains a local operator action.

## Original-order observations

Reports require the **platform order UUID**, supplied by a trusted application mapping. A local purchase ID, A2A Task ID or quote ID must not be substituted for it. No Envar UUID is required for independent A2A purchases. If there is no platform order mapping, do not enqueue a platform report.

Use a stable local event key for each original fact:

```ts
integration.enqueueStatus(`${localOrder.id}:seller:completed`, {
  orderId: platformOrderId,
  kind: "seller_completed",
});
integration.enqueueX402Payment(`${localOrder.id}:original-payment`, {
  orderId: platformOrderId,
  quote: localOrder.quote,
  payment: {
    network: originalProof.network,
    asset: originalProof.asset,
    payer: originalProof.payer,
    recipient: originalProof.recipient,
    amount: originalProof.amount,
    nonce: originalProof.nonce,
    transaction: originalProof.transaction,
  },
});
// For MPP/Stripe, provide the original PaymentIntent reference, amount and USD currency.
integration.enqueueMppPayment(`${localOrder.id}:original-card-payment`, {
  orderId: platformOrderId,
  quote: localOrder.quote,
  payment: {
    reference: originalPaymentIntentId,
    amount: localOrder.quote.amount,
    currency: "usd",
  },
});
await integration.flush({ limit: 16 });
```

Do not call both payment methods for one single-rail purchase. The examples show alternatives. Quote/profile/amount binding is checked locally; Envar independently verifies original x402 chain evidence against its frozen order. MPP reports remain `reported` unless the platform separately obtains and verifies provider evidence. A receipt header by itself is not independent Stripe verification.

The wire body is the existing platform management API, not a new Agent payment protocol:

```json
{
  "event_id": "c9c1e791-5fc8-4f16-a27c-49bff798c4a2",
  "order_id": "8a967e11-c1c8-4f57-96bc-c8e9e0efca76",
  "source_instance": "9e766b18-6a8d-4e2d-9d07-a42a4de044f5",
  "kind": "seller_completed",
  "payload": {}
}
```

Status reports accept no task result or arbitrary metadata. Payment reports whitelist only the original chain proof fields or Stripe reference/amount/currency. Prompts, full quotes, Task bodies, signatures, authorizations, SPTs and private tokens are not serialized into report payloads. Public original-order association and payment mode come from `order_id` and `payload.protocol`; actual task state and protected artifacts use the platform's owner-authorized order read path.

## Durable retries and operation

`sourceInstance`, event UUIDs, idempotency keys, payloads and retry timing survive restart. Re-enqueuing the same local key with the same fact returns its original event UUID. Reusing it for a different fact fails. Network errors, redirects, HTTP failures and invalid acknowledgments leave the original event pending. Retry delay grows from one second to five minutes. Error status exposes only a stable code, never the untrusted response body or credential.

Call `queueStatus()` to inspect pending/sent counts and redacted errors. `flush()` never signs, settles or re-runs a task. Platform outages therefore delay publication or observation only. Diagnose recurring `401`, `403` or `409` locally; do not delete the queue to make a dashboard look successful. To stop, wait for application/flush to finish, then call `close()`.

This is a single-process SQLite integration. Multi-instance coordination beyond the ownership lock and unattended platform migration are outside this module. Unit tests exercise local persistence, malicious redirects/digests/payee changes and original-event recovery. They do not prove live platform publication, payment or model execution.

## Seller CLI wiring

The seller command now implements the application callback and background synchronization. Both flags are required for opt-in:

```sh
envarpay serve --config /private/envarpay/seller.json \
  --credentials /private/envarpay/seller-credentials.json \
  --state /private/envarpay/seller.sqlite \
  --origin https://seller.example \
  --envar-config /private/envarpay/envar-settings.json \
  --envar-credentials /private/envarpay/envar.token
```

The settings file is owner-only and has this shape:

```json
{
  "policy": {
    "enabled": true,
    "platformOrigin": "https://envar.ai",
    "agentId": "54fe760a-4580-4258-9002-80f34c0d757a",
    "runtimeAgentId": "hermes-researcher",
    "acceptUpdates": true,
    "allowedServices": ["research"],
    "allowedUpstreamOrigins": ["http://hermes:9000"],
    "allowedX402": [],
    "allowedMppAccounts": []
  },
  "pollIntervalMs": 10000,
  "stateDirectory": "/private/envarpay/envar-state",
  "configDirectory": "/private/envarpay/envar-configs"
}
```

This example grants only free services. Add explicitly approved payment identities from the policy example to enable the corresponding paid updates. Required payment adapters, RPCs, merchant credentials and upstream tokens must already be configured locally. Platform updates cannot introduce them. The default integration paths are beside the seller database, and polling is bounded between one second and five minutes with failure backoff. Removing both flags starts the independent seller without an Envar connection.

At startup, the CLI restores locally applied service revisions before opening HTTP, without contacting Envar. A pending acknowledgment can also recover a configuration whose exact service snapshot already exists in the durable runtime catalog; it never activates an unregistered candidate merely because it was downloaded. This closes the crash window between catalog application and acknowledgment. Historical versions stay readable, while new requests to a retired version are refused. `GetTask` still uses the original upstream Task and service revision.

`CommerceServer.applyConfig` validates the whole configuration, prebuilds routes, registers immutable catalog entries and replaces the route map synchronously. Original Tasks, quotes and receiving profiles remain frozen. `EnvarSellerRuntime` merges each candidate into the full active catalog and returns proof read from the actual server/store, then acknowledges it. If two active services use the same payment profile name for different receiving identities, application fails; choose distinct profile names rather than silently changing another service's receiving account.

The CLI maintains `upstream-bindings.json` beside the database, with `0600` permissions inside the private runtime directory. It freezes upstream Card URL, token and input encoding by `serviceId:revision`. A later base token does not overwrite an old revision's credential. When first migrating a runtime that already has historical revisions, provide explicit `serviceId:revision` entries in `credentials.upstreams` for those historical services. Retain this file with the original database and recovery credentials. Local secret changes require restart; they are not accepted from platform candidates.

Shutdown stops admitting seller work, ends the synchronization loop and waits for in-flight operations before closing private stores. Original operation IDs and uncertain states remain available for recovery. The background coordinator flushes one durable integration event per cycle so a large offline queue cannot cause an unbounded shutdown wait.

## Buyer CLI and correlation boundary

For an MPP-only buyer, EVM private keys and RPC URLs are not required. The private
credentials file can select the built-in [Stripe issuer](stripe-issuer.md) with
`mppStripe`, or supply `mppAdapterModule`, an absolute path to an owner-only local
module exporting `createMppBuyerOptions()`. Configuring both is rejected. A custom
factory must supply authorized token creation, original-operation recovery and
independent receipt verification, plus the payer, payment method and explicit
test/live mode. Neither option creates or funds a payment method. Mixed policies
still require every configured adapter's actual credentials.

The built-in configuration reads Stripe secrets only from private files:

```json
{
  "callers": {"OWNER_MANAGEMENT_TOKEN": "owner"},
  "peerTokens": {"approved-seller": "SELLER_A2A_TOKEN"},
  "vaultKeyFile": "/private/envarpay/vault.key",
  "mppStripe": {
    "payer": "owner-approved-buyer",
    "mode": "test",
    "issuerAccountId": "acct_ISSUER",
    "secretKeyFile": "/private/envarpay/issuer.key",
    "paymentMethod": "pm_AUTHORIZED",
    "sellers": {
      "profile_test_SELLER": {
        "accountId": "acct_SELLER",
        "secretKeyFile": "/private/envarpay/seller-read.key"
      }
    }
  }
}
```

Replace all placeholders with the owner's reviewed settings. Startup performs
account/profile GETs only and fails closed on a mismatch. The issuer ledger is
created beside the buyer ledger as `<buyer-state>.stripe-issuer.sqlite3`; exact
original requests and token IDs use the existing private buyer vault. Keep both
ledgers, the vault and keys in the same consistent backup. Shutdown drains buyer
work before closing the issuer store. Test helpers require explicit
`issuance: "test-helper"` and never act as a fallback after another API fails.

The Envar flags currently wire seller configuration synchronization and its durable acknowledgments. Automatic buyer/seller commerce report emission additionally needs a trusted mapping from local purchase ID to platform order UUID. No such mapping is inferred from A2A messages, quote IDs or caller prompts. The report queue APIs remain available to an explicitly wired application hook; enabling the seller flags alone does not claim that every purchase is automatically reported.
