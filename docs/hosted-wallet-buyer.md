# Hosted wallet buyer

The optional hosted buyer runs the same `CommerceBuyer` against an Envar-owned
PostgreSQL operation. It does not host an Agent runtime or keep a second funds
ledger. Each website purchase has its own immutable context, single-purchase
grant, private recovery state and owner. No singleton signer or user policy is
swapped between requests.

Envar creates the `commerce_hostedbuyeroperation` schema and encrypts its context
with a dedicated shared 32-byte state key. The Node process has a separate role
which can read that table and update only checkpoint, lease and version columns.
It cannot create grants, alter account balances or modify journal history. The
Envar schema/permissions changes must be deployed before this service.

## Durable execution

1. Claim the original operation using a PostgreSQL lease and version.
2. Verify its AES-GCM context is bound to the operation ID, owner and configured
   wallet issuer/environment.
3. Restore the original SDK record into a private in-memory SQLite projection,
   and restore its memory vault. There is no shared SQLite volume.
4. Commit encrypted state to PostgreSQL **before every outgoing wallet or seller
   HTTP request**, including reserve, credential replay and original Task reads.
5. Commit the resulting SDK state before responding. A lost version/lease fences
   the worker before its next external request.

If a worker dies after sending an already-checkpointed request, the next worker
loads the same body, message ID, reserve key and authorization. Wallet and seller
idempotency preserve the original charge and Task; this is not a claim of a
global distributed transaction. Read-only `get` polls existing Task IDs and does
not replay payment. Explicit `recover` can resume the original approved purchase.

Pending website grants are not approved and are expired at the funds authority.
The BFF records the user's quote confirmation before enabling that one grant.
The Node process cannot set the approval column. Calling its confirm endpoint
before approval cannot spend funds. Clarification continues the existing Task
within the SDK's original bounded input rules.

## Private service configuration

Run `envarpay hosted-buyer --config private/hosted.json --origin <private-origin>
--port 4021`. The JSON file and referenced files must be owner-only:

```json
{
  "databaseUrlFile": "private/buyer.database",
  "stateKeysFile": "private/state-keys.json",
  "tokenFile": "private/bff.token",
  "walletIssuer": "https://wallet.example.com",
  "environment": "live",
  "maxConcurrent": 8
}
```

The database URL uses only the hosted-buyer database role. Live connections require
`sslmode=verify-full` plus `sslrootcert`. The state key file is a JSON keyring:
`{"active":"k2","keys":{"k1":"base64-old-key","k2":"base64-current-key"}}`.
Each value encodes 32 bytes and matches Envar's `HOSTED_KEYS`/`HOSTED_ACTIVE_KEY`.
Versioned envelopes authenticate the key ID, purpose and operation. Keep prior
keys while retained operations/backups need them. An optional `legacy` base64 key
allows reading old raw envelopes. Raw `stateKeyFile` is supported only for
isolated sandbox fixtures. `bff.token` is a
separate strong internal credential. No database credentials or key material
are returned to a browser or Agent. Do not put these files in Git.

The internal API accepts `POST /v1/operations/{id}/{preview|confirm|get|recover|continue}`
with the BFF Bearer credential. It loads the owner, policy, endpoint and spending
credential from the encrypted database context, not from HTTP request fields.
Expose this API only to the BFF through an authenticated private network/TLS
boundary. The default listener binds loopback.

`/health` reports process liveness. `/ready` checks the actual database SELECT and
checkpoint permissions and refuses readiness if the role can approve purchases
or insert ledger entries. Authenticated `/metrics` exposes active operations,
success/failure counts and draining state without user or payment identifiers.
At capacity the service returns a retryable busy response. SIGTERM stops new work,
drains the HTTP server and then closes the database pool; the existing bounded
shutdown deadline still applies.

Inside Envar, optional `walletTransportOrigin` may name only
`http://envarai-wallet.<namespace>.svc.cluster.local:8000`. It routes requests for
the pinned public issuer to that fixed internal service. Purchase input cannot
override it, and it does not loosen public-address validation for seller calls.

Kubernetes projects Secrets as symlinks. Preserve the CLI's private-file checks:
copy selected files into a memory-backed volume in a restricted init container,
set owner-only permissions and mount the copy read-only in the buyer. Envar's
wallet deployment renderer implements this pattern. Rotate keys/tokens through
a controlled rolling replacement rather than editing an active private file.

Seller requests resolve all DNS answers and reject private/reserved addresses,
then pin a public address while retaining the original Host and TLS SNI. They
never follow redirects. Loopback HTTP requires explicit sandbox mode; it is not
allowed for a live wallet. The wallet issuer is separately operator pinned.

## Verification

Normal `npm test` discovery includes context/purpose tampering, cross-owner
rejection, a failed checkpoint preventing network access, pre-approval denial,
preserved budget/authorization state, and private-address/redirect checks.
The coordinated Envar sandbox additionally uses real PostgreSQL roles and HTTP
services to exercise a paid-response failure, recovery and hosted-process
restart. It asserts one execution, preserved Task ID, balanced journals and zero
projection drift. These are simulated CNY funds and deterministic Agent results,
not live payment-provider or model-billing evidence.
