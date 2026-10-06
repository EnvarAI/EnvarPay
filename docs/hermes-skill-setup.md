# Connect Hermes Skills to Envar

The setup and discovery commands are included in **0.2.0-alpha.12**. Node.js22.14+ is required; Node24 is recommended. Hermes must already have a working OpenAI-compatible model configuration.

## Send a prompt to your Agent

Open Envar **Services & pricing**, select **Copy setup prompt**, and send the copied text to your own Hermes. The Agent needs terminal tools and installation/network access in its own runtime. It saves the short-lived invitation privately and runs:

```sh
npx --registry=https://registry.npmjs.org --yes --package @envarai/envarpay@0.2.0-alpha.12 envarpay onboard --file /private/invitation.json
```

`onboard` is noninteractive: it detects the local Hermes interpreter/config, chooses an available local port, uses an existing tunnel or installed `cloudflared`, starts a private service, and asks Envar to verify and bind this same Agent. Inside Docker it runs inside that environment, without a Docker socket mount or host port mapping. If cloudflared is needed, the Agent installs it from its official distribution; the CLI reports a concrete error if it is missing.

Envar verifies the actual Card and fresh runtime heartbeat before returning `status=connected`, exact `agent_id`, `verified_at`, discovered Skills and `services_url`. The Agent outputs `ENVAR_CONNECTED` only with this receipt. The webpage also checks the live setup, so an Agent's claim alone cannot finish onboarding. Use `onboard --file ... --check` for the current receipt.

Invitations expire in one hour and can be replaced in Envar. They can bind only the selected Agent and cannot edit prices, publish or spend. The derived runtime credential stays private. Existing services, ledgers and Skills are preserved. A temporary HTTPS tunnel must remain running; it can change on restart. Background startup is not reboot persistence: the Agent must separately configure the user's existing service manager or explain the limitation.

## Manual guided setup

1. In Envar, open your Agent's **Services & pricing**. If no sellable Skills are connected, the page shows **Enable Skill services** instead of an empty editor.
2. Download the Agent setup file. It contains the existing Agent identity and a private, revocable connection credential. It contains no model key or wallet key. Keep it local.
3. In the download folder, run the generated command on the Hermes host:

   ```sh
   npx --registry=https://registry.npmjs.org --yes --package @envarai/envarpay@0.2.0-alpha.12 envarpay setup \
     --file envar-setup-AGENT_ID.json --docker-container my-hermes
   ```

   For a local installation, omit `--docker-container`. Setup asks for the Hermes Python interpreter; `--python /path/to/hermes/.venv/bin/python` and `--hermes-home /path/to/profile` override detection. Docker setup checks the actual Hermes constructor's isolation capabilities, rather than selecting an interpreter solely because it can import Hermes.

4. Optionally select existing Skills, or press Enter to start with none. Newly installed Skills appear privately on the Envar service page within about 30 seconds while both runtime and page are online. For a first example, install the community [copywriting Skill](https://github.com/coreyhaines31/marketingskills/tree/main/skills/copywriting) in Hermes:

   ```sh
   hermes skills install coreyhaines31/marketingskills/skills/copywriting
   ```

   Run this inside the Hermes environment, or prefix with `docker exec -it my-hermes`. The service adapter currently supports text input and output with bundled Markdown references. Review the selected package and confirm it can work without browser, shell, file or API tools. File extensions alone do not certify this. Setup preserves original Skills and makes versioned, reviewed service copies with an instruction-only execution profile.

5. Choose a local port and a public HTTPS origin. Setup can add a dedicated tunnel to an already running local ngrok session without changing existing tunnels. Alternatively, supply your reverse proxy's HTTPS origin and forward it to the printed loopback port. Keep the original unrestricted Hermes endpoint private when selling paid work.
6. Start the generated `start.mjs` using the printed command. Keep this terminal, Hermes, and the HTTPS tunnel running. The runtime initially advertises installed Skills with **zero executable offers**; it cannot run unpriced work.
7. Import the generated `connection.json` into the Envar setup page. It updates this same Agent's A2A endpoint and reads its real Skill inventory. Wrong-Agent files are rejected. If the endpoint is unavailable, keep the service online and import the same file again to retry.
8. New Skills show **New · not listed**. Review text-only compatibility and select **Enable text Skill**. EnvarPay prepares that exact source version; the page checks its A2A Card and makes it selectable. Describe the output, build the buyer form and save an offer. Request publication, wait for the running EnvarPay process to apply it, then choose **Check and publish**. Discovery and enablement never publish automatically.

## Upgrade an existing setup

Run `envarpay upgrade --directory ~/.envarpay/AGENT_ID` with alpha.11. Custom directories and local profiles are supported with `--directory` and `--hermes-home`. Stop the original foreground process and run its updated `start.mjs`. The original port, access tokens, ledger and service copies remain intact. Newly installed Skills are scanned without another restart. Updated source files are marked separately; an existing service keeps its pinned copy until a deliberate new version is prepared.

## Guided USDC receiving

Choose a paid offer in Envar. The page links to receiving-wallet verification and lets you download `envar-receiving-AGENT_ID.json`. Run the generated `envarpay payments --directory ... --file ...` command locally. Confirm the receiving address/network, configured facilitator, network RPC and authorized buyer wallet. The command prepares receiving verification, preserves the original signer/budget state, and writes a dedicated buyer-access token to a private file. Share that file only with the configured buyer.

Restart EnvarPay. After its payment-adapter checks succeed, the page detects the matching receiving configuration and enables saving the price. A disconnected runtime or a different verified payee stays unready. This path supports USDC; Stripe eligibility and merchant setup retain their separate flow. No payment is performed by configuration.

## Ownership and recovery

- Model credentials are read locally. A simple Hermes `key_cmd: cat /path/to/key` is referenced without executing arbitrary configuration commands. Other supported environment/config credentials are copied through private pipes into an owner-only file, never printed or put in shell arguments.
- Docker tasks use `docker exec` from the host. There is no Docker socket mount. Every order uses a fresh task workspace and only its authorized Skill instructions; no model tools or personal memory are loaded.
- Each setup gets its own private directory, ledger, access token and service copies. Rerunning setup never resets an existing directory. Use its original start script to restart. Failed host-side preparation removes only its temporary staging directory.
- The generated script uses the same installed npm package and Node executable as setup. Keep that installation available. If upgrading, preserve all local config/ledger files and use the new CLI's `serve` command with the same arguments.
- Agent-scoped platform credentials currently expire after30 days. Replace the local `envar.token` with a newly issued credential and restart; never recreate the ledger to renew credentials.
- This first setup authorizes **free service updates only**. Enabling USDC or Stripe requires the separate [seller payment configuration](a2a-commerce.md), verified receiving identity and local payment adapters. It never creates a wallet, broadens a buyer budget, publishes a service or makes a payment automatically.
- Newly installed Skills are discovered automatically and become executable only after explicit owner enablement. For changed contents of an already enabled Skill, prepare and publish a new version deliberately; automatic discovery never replaces a live service package. Existing order state remains intact.

Connection files contain secrets and must not be committed, pasted into chat, or placed in browser storage. Envar receives only its scoped connection credential and service credential; the Agent's model and signing keys stay local.
