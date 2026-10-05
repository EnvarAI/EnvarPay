# Skill-named services and payment gate

## Decision

The sellable service's canonical `id` and `name` are the installed Agent Skill's
`name` (for example, `short-drama`). The owner chooses the skill; there is no
separate name-to-skill mapping field. A2A 1.0 remains the buyer-facing Card,
`SendMessage`, Task, and artifact protocol. A skill is the seller Agent's local
implementation, not a new buyer-facing payment protocol.

The exact installed content digest is pinned in the immutable service revision.
It is machine-managed, not a second name the owner must type. A name alone is not
authority: a generic A2A endpoint can advertise `research` while executing an
unrestricted prompt. Skill pricing requires a skill-aware runtime adapter, and
an unscoped native A2A executor fails closed for new skill-bound configuration.

## Contract

`configVersion: 2` uses the existing service and offer structure with:

```json
{
  "id": "short-drama",
  "name": "short-drama",
  "execution": {
    "type": "skill",
    "cardUrl": "http://127.0.0.1:9111/short-drama/agent-card.json",
    "skillDigest": "<64 lowercase hex characters>"
  }
}
```

The runtime must list exactly one installed descriptor with this name, digest,
and private Card URL. The public offer Card still advertises the skill under
standard A2A `skills`. Its optional EnvarPay extension adds `skillDigest`.
Quote `termsDigest` includes the skill name and digest, so a changed skill needs
a new reviewed service revision. Existing `configVersion: 1` receipts and Tasks
retain their original digest and recovery behavior.

## Dispatch and access

The seller gateway authenticates the caller, validates the frozen input and
quote, and confirms an actual payment before placing a paid Task in the durable
outbox. A free offer may enter the outbox without payment. The skill-scoped
executor receives only the purchased service name and a per-order grant bound to
the caller, message ID, input digest, and skill digest. It invokes that exact
skill. The reference registry permits nested calls to the purchased skill and
declared free skills; another paid skill raises `skill_payment_required` and
requires its own quote and purchase. It never auto-purchases during a Task.

The Agent-owned adapter must route by the passed name and use the grant on every
nested skill call. Paid skills and the raw Agent entry must not be directly
reachable by buyers. A string inside buyer input, a Card label, or a system
prompt cannot confer skill authority. If a framework cannot enforce per-task
skill access, it cannot publish paid skill services through this mode. Separate
restricted Agent profiles are a viable framework adapter when task-scoped skill
allowlists are unavailable.

Recoveries and clarifications keep the original Task and skill digest. If the
old skill version is unavailable, the runtime reports an unresolved execution
state for manual review; it must not substitute a new skill or charge again.

## Product follow-through

Envar must list the verified Agent's installed skill names, let the owner select
one, and set the service ID/name from that selection. It must require the
corresponding runtime descriptor and digest before new skill-priced revisions
can publish. Free skills use zero-price offers through the same A2A wire.
Publication proves the route and unpaid price gate; a seller-run sample Task is
needed to demonstrate actual invocation. Neither check certifies creative or
professional quality. Services with misleading claims remain subject to human
review and reputation signals.

The EnvarPay SDK supplies the registry and payment boundary. Hermes and OpenClaw
adapters must still constrain their own skill loaders or use isolated profiles;
merely prepending `/short-drama` to a generic prompt is insufficient. Real paid
acceptance requires one confirmed payment, exact named-skill execution, result,
original Task recovery, another paid skill denied, and financial readback.

## Native implementation scope

The built-in adapter now supports native Hermes/OpenClaw instruction-only tasks. It hashes
installed packages, publishes a multi-skill inventory Card and creates isolated per-order
profiles without model tools. This is a deliberate supported execution profile, not a
universal sandbox for arbitrary downloaded skills. File/API/browser skills fail the
compatibility check unless reviewed for another adapter. General model knowledge cannot be
partitioned by paid topic. Other installed paid packages and tool execution remain inaccessible.

Existing generic services may coexist in a v2 local catalog so historical orders recover;
new platform-created services always use exact skill name, type and digest. Publication
reads the owner's runtime inventory; it does not certify arbitrary sellers' installed state.
