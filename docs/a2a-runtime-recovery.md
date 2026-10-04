# Durable A2A continuation and original-task recovery

The TypeScript commerce runtime persists the purchased service revision, original input, payment attempt, local Task, remote Task identity and dispatch state. SQLite is single-process and protected by an ownership transaction; WAL uses full synchronous durability. Upgrading a version 1 ledger to version 2 preserves original order IDs, payments, credentials, Task IDs and outbox entries while adding clarification state.

## Waiting is a real Task state

A remote `TASK_STATE_INPUT_REQUIRED` or `TASK_STATE_AUTH_REQUIRED` remains that state on the public A2A Task. It is not converted into a completed, failed or unknown execution. `GetTask` is free and owner-scoped. It may refresh a nonterminal original task through the configured upstream's official `GetTask` method. An unavailable or vanished upstream preserves the last recorded state and original recovery identity; it never causes a new `SendMessage`.

The runtime freezes the original remote Card URL, selected JSON-RPC interface, Task ID and context. An interface or identity change fails closed. Historic service revisions remain readable and existing waiting tasks can be clarified under their original contract after a new revision becomes current.

## Clarification within the purchased task

A client sends standard A2A `SendMessage` to the original offer with a new stable `messageId`, the original public `taskId`, optional matching public `contextId`, and one structured data part. The service must have declared optional clarification fields in its original JSON Schema.

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-clarification-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "clarification-1",
      "taskId": "original-public-task-id",
      "role": "ROLE_USER",
      "parts": [{"data": {"topic": "original topic", "clarification": "Focus on published pricing"}}]
    },
    "configuration": {"returnImmediately": true}
  }
}
```

Only absent, explicitly declared fields may be filled. Existing values cannot change, arrays cannot be extended, and priced quantity paths cannot change. The merged input must validate against the frozen schema. Ten clarification rounds are allowed; `includedRevisions: 0` still means no separately revised deliverable or new task is included. A generic `{prompt:string}` service with no declared optional clarification fields cannot accept arbitrary extra prompts through this API.

The original owner, service revision, offer and confirmed payment (or free order) are rechecked before enqueueing. A caller-supplied Task ID never bypasses payment on a new order. Clarification of an existing paid task does not call the payment gate or create another authorization. Terminal tasks reject new messages; retrying an already accepted clarification returns the current original task.

Each clarification has its own durable outbox record. Reusing the same message ID with a different body conflicts. A ready record can dispatch after restart, but an interrupted dispatch becomes unknown and is never automatically resent. Recovery queries the original Task. If the response history acknowledges the original clarification message ID, or the Task has reached a terminal state, recovery can clear that pending clarification. Otherwise, another round remains blocked: observing an old input-required state alone does not prove a lost message was accepted.

## Executor interface

Existing custom executors remain callable for initial execution. Continuation and recovery require explicit optional methods; absence fails closed for continuation and preserves stored reads for recovery.

```typescript
const executor = nativeA2AExecutor(runtimeTokens, fetch, shutdownSignal);
const server = new CommerceServer({
  config, origin, store, authenticate, execute: executor,
  paymentGate,
  stripeRecipientFor: accountRef => verifiedMerchantProfiles[accountRef],
});
```

The native executor uses official A2A SDK codecs/client calls. `executor.continue` sends the saved remote Task/context IDs and stable clarification message. `executor.recover` only calls `GetTask`; `executor.remoteInterface` lets the store persist the exact selected interface. Custom implementations must preserve those same identities and must never hide a new-task fallback in recovery.

MPP quote construction requires a resolved merchant profile from `stripeRecipientFor`; missing merchant readiness fails before collecting. Both preflight and handler quote paths use the same resolver. Authentication and payment protocol handling remain separate from execution.

## Operations and validation

Stop accepting new requests before closing the ledger. `server.stop()` wakes waiters and stops further queued dispatch; caller-provided shutdown signals bound upstream network calls. Wait until `server.isRunning` is false before `store.close()`. Task streaming, push subscriptions and cancellation remain explicitly unsupported.

Task listing applies owner, tenant, status, context and timestamp filtering in SQL before bounded pagination. Task snapshots and HTTP input/output remain size-limited.

Tests use local SQLite, official SDK wire fixtures and simulated payment gates. They cover waiting states, same-task continuations, original-field protection, paid-first ordering, ten-round bounds, unknown continuation recovery, cross-owner denial, restart persistence, v1 ledger migration, exact upstream interface binding, GetTask-only recovery and bounded listing. These tests do not prove real provider billing, model execution or chain settlement; release acceptance must run those separately.

Some native A2A runtimes accept text parts while ignoring structured data parts. Select that input representation explicitly with the executor's fourth argument:

```typescript
nativeA2AExecutor(runtimeTokens, fetch, shutdownSignal, {
  inputEncoding: { 'assistant-request': 'json-text' },
});
```

The default is `data`. `json-text` serializes the already validated object into a JSON text part, preserving the original message, Task and context IDs for initial and continuation requests. It never retries a rejected request with another encoding. This option does not restrict a general assistant's capabilities: publish a bounded general assistant-request service honestly, and use an actually constrained upstream implementation for narrowly scoped services. Historical upstream credentials can be configured with `serviceId:revision` keys; otherwise the explicit per-service token is used.
