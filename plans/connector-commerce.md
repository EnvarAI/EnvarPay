# Connector service orders (P4)

Version `2026.1027.2` adds Agent-facing service discovery, quotes, owner-budget confirmation and original order recovery. Envar owns all prices, reservations, captures, releases and grant counters. PayBackend is unchanged.

- The canonical Work schema adds original order/quote/confirmation documents. The SDK regenerates types from the byte-identical EnvarAI source and validates money/identity fields.
- `client.ts` keeps every request on the configured Envar origin, with no redirect or invisible POST retry. Confirmation cannot supply a new amount or recipient. Approval URLs must identify the same first-party order.
- `state.ts` persists quote request bodies before dispatch and binds successful responses to the original order ID. Reusing an ID with changed content fails; `list_orders` obtains server-persisted original orders across local reconnects.
- `mcp.ts` advertises read and write tools only under their connection scopes. Paid confirmations additionally need the separately owner-created grant. Confirmation is declared as a consequential write; no top-up, withdrawal or grant-creation tool exists.
- Native receiving accepts terminal work canceled before its first claim without fabricating a UUID. An updated package requires native MCP reload even when its launch path is unchanged.

Tests cover lost quote/confirmation responses, changed request content, integer money validation, another order/origin returned by the server, no read-only spending tool and native configuration reload. Real six-direction Agent execution and balance acceptance remain the consolidated release gate.
