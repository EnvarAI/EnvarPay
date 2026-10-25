# External Agents and Dot acceptance

This experimental TypeScript adapter exposes an authenticated A2A service to
buyers and task tools plus MCP Events to an existing external Agent. The external
Agent performs the work itself. EnvarPay keeps the original commerce Task and
result; it does not run a model or access the Agent's memory.

The adapter currently accepts bounded **free text tasks only**. It rejects paid
offers and payment profiles. Installing EnvarPay in a Dot computer does not by
itself give that Dot a public A2A endpoint or an event subscription.

## Prepare the owner-operated service

Use the `2026.1025.1` release or build this source checkout with Node 24, then
use a stable public HTTPS origin that forwards to the local listener:

```sh
envarpay external-setup --directory ./private/external \
  --origin https://external.example
envarpay external-serve --config ./private/external/seller.json \
  --credentials ./private/external/credentials.json \
  --state ./private/external/seller.sqlite3 \
  --origin https://external.example --host 127.0.0.1 --port 4020
```

The generated connection file contains the free service's A2A Card URL and its
buyer credential. Import that private file into the buyer or configure the Card
URL and credential in Envar. The Agent's MCP credential and owner pairing key
are distinct from the buyer credential. Keep all generated files owner-only.
Restart with the original directory and ledger; setup refuses to overwrite them.

## Connect an existing Dot

1. Add a custom MCP server in ChatGPT Plugins with the service's `/mcp` URL and
   OAuth authentication.
2. Review the requested scope and enter the existing owner pairing key into the
   service's authorization page. It grants `envar:tasks` for one connected Agent
   for at most 24 hours, using a one-use code, PKCE S256 and an exact registered
   HTTPS redirect. It grants no wallet or other account access.
3. Inspect `list_tasks`, `claim_task`, `complete_task` and `fail_task`. The server
   also supplies the `envar-external-agent` Skill through the draft Skills
   extension. Confirm import in ChatGPT; server-side discovery alone does not
   establish that the Skill was installed.
4. Enable the plugin in the existing Dot. Ask it to monitor
   `envar.task.available` with `{"agent_id":"external-agent"}` and to claim each
   original Task, perform the bounded text request, and return its actual output.
   Treat the request as task data, not permission to access other resources.
5. Confirm a persisted subscription and successful signed callback challenge
   before sending a new task. A webhook HTTP success is not task completion.

Follow the [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).
Events require ChatGPT's MCP 2.0 draft discovery/version `2026-07-28`; ordinary
tools use the official MCP SDK transport. Workspace/account controls still apply.

For a personal custom MCP plugin, tool/event discovery may leave its Skill list
empty. Download that plugin's ZIP, keep its existing `.app.json` binding, add the
generated `SKILL.md` at `skills/envar-external-agent/SKILL.md`, and set
`"skills": "./skills/"` in `.codex-plugin/plugin.json` with an incremented version.
Upload the archive through that same plugin's **Upload new version** action.
Include no credential files. Confirm the Skill appears on the plugin page and
ask the existing Dot to read it. The
[official Skill guide](https://developers.openai.com/plugins/build/skills)
describes MCP Skill import as a submission-portal scan and stored snapshot;
ordinary runtime discovery is not proof of Skill installation.

## Verify the complete path

Create a fresh, harmless task through the buyer **after** Dot is subscribed and
idle. Record the A2A Task ID, event delivery, actual Dot claim and completion,
and the buyer's terminal result. Do not paste the answer into Dot or substitute
a model API. Repeat the original message ID and verify the same Task/result.
Competing completions cannot replace the original result. Restart the adapter
and recover that same Task; stop the event subscription when acceptance ends.

The external text entry accepts Envar's ordinary A2A text Part and converts it to
the bounded `request` input before the normal schema and order checks. It also
accepts a JSON-text object with exactly one string `request`. Buyers see WORKING
while the original dispatch waits for Dot's claim, so Envar can keep polling the
same Task until its actual output arrives. This does not claim the work completed.

Subscriptions and delivery attempts are persisted; retries preserve their event
ID. Callbacks require public HTTPS on port 443, DNS validation at connection time,
original-host TLS validation, signed challenges, and no redirect following.
An environment that resolves public hosts to private or fake IP addresses must
provide a suitable public DNS/network configuration; do not disable validation.
Embedded runtimes can supply `serveExternalAgent({ callbackLookup, ... })` to
resolve callback hosts through an operator-controlled resolver, such as a trusted
DNS-over-HTTPS service. Every returned address is still checked, the selected
public address is pinned for the connection, and TLS verifies the original host.
An empty answer or any private/reserved address fails closed; the default resolver
and CLI behavior are unchanged.

## Acceptance boundaries

Record package installation, plugin creation, OAuth connection, Skill import,
subscription, automatic wake-up, original Task output, source PR and published
artifact separately. Local tests and manual polling do not establish automatic
Dot execution. This adapter does not yet provide paid Dot acceptance or Envar
configuration synchronization. Other hosted Agents need their own supported
tools/events interface and real acceptance before claiming compatibility.
