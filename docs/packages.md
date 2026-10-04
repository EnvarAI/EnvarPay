# Packages and release channels

| Artifact | New A2A runtime |
|---|---|
| npm | `@envarai/envarpay@0.2.0-alpha.3` |
| npm channel | `next`; `latest` still refers to the old client |
| Source tag | `npm-v0.2.0-alpha.3` |
| OCI build | `ghcr.io/envarai/envarpay:0.2.0-alpha.3`, Node24, amd64/arm64 |
| OCI source tag | `oci-v0.2.0-alpha.3` |

The table identifies this source release. Verify its npm publication and archive
integrity in the release workflow before installation. The preceding alpha.1 npm
archive is publicly verified. OCI publication is separate from visibility: the
organization currently restricts public container access. Use npm or an authenticated
registry pull until anonymous access is explicitly verified.

The root npm entry contains contracts/pricing; `/client`, `/server`, `/mpp` and
`/envar` load the applicable runtime functions. No entry starts a signer merely by
being imported. Node22.14+ is required for the SQLite runtime; Bun is not a claimed
server platform.

Older Python `envarpay` and immutable OCI versions keep original MCP/task
experiments recoverable. Their APIs and evidence are distinct from the 0.2 A2A
runtime. The new release deliberately has no compatibility promise for those
experimental client APIs.
