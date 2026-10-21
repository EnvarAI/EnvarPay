# Getting started

Use the TypeScript A2A commerce runtime from
`npm install @envarai/envarpay@0.2.0-alpha.4` with Node24 recommended.
The `next` npm channel is the new runtime; pin the exact tested version after its
[archive publication is verified](packages.md).

1. Run your existing Agent's native A2A entry privately and verify a real task.
2. Define a bounded service, input schema, delivery and free/fixed/quantity offer.
3. Configure the seller's receiving identity and private upstream credentials.
4. Configure a separate buyer with exact peer, recipient, per-purchase and
   cumulative limits. Start with testnet and review every purchase.
5. Preview, confirm one original request, read Task/result and independently
   verify payment. Recover the same operation on uncertainty.
6. Optionally add the public offer Card to Envar, prove endpoint ownership and
   receiving identity, apply the service configuration and publish after probing.

[Complete seller walkthrough](a2a-commerce.md) · [Buyer policy and management](a2a-buyer.md) ·
[Hermes/OpenClaw native integration](a2a-agents.md) · [Envar](a2a-envar.md) ·
[Container operations](container.md)

The older Python/MCP and experimental escrow guides are retained for existing
operation recovery. They are not the new service-commerce onboarding path. Never
recreate an uncertain old purchase as a new A2A request.
