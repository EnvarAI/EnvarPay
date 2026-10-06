# Agent-executed onboarding

The owner copies one prompt addressed to their Hermes. A one-hour invitation authorizes connection of only that existing Agent. The Agent uses the noninteractive EnvarPay onboard command, discovers its local runtime, starts a separate gated service and reports the connection. No shell/file/port steps are required from the owner in the default flow.

The platform claims the invitation idempotently, receives a heartbeat from its derived Agent credential, probes the actual HTTPS Skill inventory Card, and atomically binds the endpoint only if the original Agent endpoint snapshot is unchanged. It issues a receipt only for a current verified connection. Regenerating an incomplete invitation revokes the earlier ticket and derived credential. Tokens are hashed server-side and never included in receipts.

The prompt requires ENVAR_CONNECTED plus agent identity, verification time, discovered Skills and service-page link; failure is SETUP_BLOCKED with the exact missing dependency or permission. No publication, price, wallet or transfer is performed. The manual setup stays available as a fallback.

The local CLI supports Hermes inside Docker without host socket access, uses existing HTTPS or outbound cloudflared, preserves local ledgers, and retains a restart command. Temporary tunnels and lack of boot persistence are reported honestly.

Verification: owner/expiry/revocation, heartbeat identity, endpoint compare-and-set, actual Card check, idempotent replay and safe receipt; browser copy/auto-complete; real isolated Hermes given the generated prompt through its native executor.
