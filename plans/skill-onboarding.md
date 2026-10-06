# Guided Hermes Skill onboarding

## Scope

Complete the missing transition from a connected native Hermes to named Skill services. Keep existing native chats, model configuration, wallets and service ledgers intact.

## User flow

1. The empty service editor shows a focused setup guide, local/Docker choice, and a downloaded Agent-scoped setup file.
2. `envarpay setup --file ...` inspects Hermes locally, selects reviewed text Skills, reads existing model settings, generates private seller/sync files, and uses a dedicated HTTPS tunnel or the owner proxy.
3. The owner starts the generated service and imports connection.json in the same Agent. Existing endpoint verification reads the real inventory before the service editor appears.
4. Start with a free service. Existing publication request/apply/check flow remains. Paid receiving and buyer policies remain separately configured.

## Boundaries

- No hosted Agent, platform signer, automatic payment or automatic publication.
- No invented skills, name mapping, model fallback, Docker socket mount or ambient personal memory in paid tasks.
- Setup supports Hermes text-in/text-out workflows. It preserves original installed Skills and creates reviewed service copies.
- An empty local catalog permits discovery before the first service exists and cannot execute unpriced work.
- Downloaded settings and returned connection files contain local secrets; they stay out of URLs, shell arguments, browser storage and logs.
- EnvarPay alpha.10 must be published before the frontend guide is deployed.

## Validation

CLI parsing/credential rejection, package integrity and copy preservation, empty-catalog gate, existing commerce regressions, browser download/import/wrong-Agent checks, desktop/mobile layout, actual Docker Hermes setup and A2A output.
