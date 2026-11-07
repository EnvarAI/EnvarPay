# Run a free local A2A service

This example makes one real, authenticated A2A request through EnvarPay's HTTP server, SQLite order store and task worker. The seller calls a second private, loopback-only A2A service through the existing native A2A executor.

The private capability deterministically uppercases text. It uses no model, Envar account, wallet, paid service or external API. This demonstrates the free execution path and **completed-result replay after a process restart**; it does not demonstrate AI quality, payment settlement, or recovery of an interrupted model run.

## Requirements

Use Node.js 22.14 or newer; Node 24 is recommended. The example uses POSIX owner-only file permissions (Linux/macOS). Both servers bind to `127.0.0.1` on local ports selected for the example. There is no public tunnel.

## From the published package

Run this in a directory where you want a local package installation:

```sh
npm install --ignore-scripts @envarai/envarpay@latest
node "$(npm root)/@envarai/envarpay/examples/local-free-service/demo.mjs"
```

The example is included in the npm artifact. It imports the supported `@envarai/envarpay/server` entry, so it does not depend on a source checkout or a Python installation.

## From source

From the repository root:

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
node examples/local-free-service/demo.mjs
```

To choose a persistent, empty state directory:

```sh
node examples/local-free-service/demo.mjs --state-dir ./private/local-free-state
```

The example creates that directory with owner-only permissions. An existing directory must already be private (mode 700) and belong to this example. Reuse its original directory to replay the same task; do not delete a journal to make a retry look new.

## What happens

1. The driver starts a server process containing a seller A2A entry and a private deterministic A2A capability, each with a real SQLite store.
2. It reads the seller's Agent Card and checks that an unauthenticated invocation is rejected.
3. It submits fixed `messageId: local-free-service-original-v1` with the fixed example input.
4. The seller creates a real free order and calls the private A2A service. The capability produces `DEMO ONLY: HELLO FROM THE LOCAL FREE SERVICE`.
5. Sending the same message returns the same Task. Changing the input under that message ID is rejected.
6. The driver stops the server process, starts a new process against the original state files, then calls `GetTask` and replays `SendMessage`.
7. It reads back both SQLite stores and the private capability's execution log: one order and one completed Task per store, one capability execution total, and zero payment attempts.

The output includes actual values like:

```json
{
  "message_id": "local-free-service-original-v1",
  "task_id": "<original Task UUID>",
  "replay_task_id": "<same Task UUID>",
  "restarted_get_task_id": "<same Task UUID>",
  "restarted_replay_task_id": "<same Task UUID>",
  "capability_executions": 1,
  "paid_operations": 0
}
```

The IDs are obtained from the HTTP responses and checked against SQLite; they are not hardcoded success output. The two process IDs are also reported. Rerunning the command with the same state directory must preserve the same result and execution count.

## State and authentication

The selected directory contains:

| File | Purpose |
| --- | --- |
| `demo.json` | Stable local ports and example identity |
| `tokens.json` | Separate randomly generated buyer and private-runtime bearer credentials |
| `seller.sqlite3` | EnvarPay seller orders and Tasks |
| `runtime.sqlite3` | The private demo service's orders and Tasks |
| `executions.jsonl` | Records when the deterministic capability actually executes |
| `result.json` | Checked, non-secret evidence from this run |

Tokens are written to owner-only files and are never printed. This is a local example profile, not a production authentication or deployment recipe. The server refuses unrelated/non-private state directories, and a port collision fails rather than silently changing the saved service binding.

## Run only the example server

For inspecting the local HTTP service while it is running:

```sh
node examples/local-free-service/server.mjs --state-dir ./private/local-free-state
```

It prints its loopback origin and PID, not credentials. The offer is at `/services/uppercase/v1/offers/free/agent-card.json`; its JSON-RPC endpoint ends in `/a2a`. Stop this process before running the automated demo against the same directory. Only one owner may use each ledger.

The driver in [demo.mjs](../packages/typescript/examples/local-free-service/demo.mjs) shows the actual `SendMessage` and `GetTask` requests. The private capability and seller composition are in [server.mjs](../packages/typescript/examples/local-free-service/server.mjs).

## What this does not change

The configuration has no payment profiles and lists only a free offer. It uses the SDK's existing free-order branch. Paid offers still require the normal Envar balance integration and captured receipt; this example introduces no fake payment or bypass.

An unfinished external task can still have an unknown result after disconnection. The existing recovery tests cover those boundaries; the completed result shown here must not be used to claim every native runtime survives restart.

Run the normal suite with `npm test`. It discovers `test/local-free-service.test.mjs`, which verifies real HTTP, distinct server processes, unchanged Task IDs, persisted results, no extra execution, and the same example from an offline-installed npm tarball.
