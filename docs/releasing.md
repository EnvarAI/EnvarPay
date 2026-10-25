# Stable releases

The supported package is `@envarai/envarpay` on npm. Stable versions use
`YEAR.MONTHDAY.SEQUENCE`, for example `2026.1025.1`, `2026.1025.2`, then
`2026.1026.1`. npm requires three numeric components, so `20261025.1` is not a
valid package version. Components have no leading zeros: January 5 is `2027.105.1`.
Release dates use Asia/Shanghai.

## Prepare a release

From `packages/typescript`, run:

```sh
npm run version:date
npm test
```

Commit package.json and package-lock.json with the implementation and changelog.
The version command increments the sequence for the same day and starts at 1 on
a later day. Include a new version whenever the published package or image changes.
PR validation checks the packed CLI, runtime helpers, public exports and npm
integrity so an existing version cannot silently receive different contents.

## Automatic publication

A relevant push to `main` runs `.github/workflows/publish-npm.yml`:

1. Run the seller and release tests on Node 22 and 24; install and exercise the
   actual packed npm tarball.
2. Build and check the container on amd64 and arm64 without network access at runtime.
3. Publish one multi-platform image under both immutable versioned names:
   `ghcr.io/envarai/envarpay:VERSION` and `ghcr.io/envarai/envarpay-commerce:VERSION`.
4. Publish the tested Node 24 tarball to npm `latest` with provenance, using the
   existing npm Trusted Publisher for this repository, workflow and `npm` environment.
5. Verify the public npm version/integrity and both image identities; update image
   `latest` aliases and record GitHub release `vVERSION` at the tested source commit.

The two image names are compatibility aliases for the same artifact. Standalone
users can call `envarpay`; managed deployments can copy `/opt/envarpay` and invoke
`node /opt/envarpay/dist/commerce/cli.js` as before. Python runtime helpers now live
under `/opt/envarpay/runtime` and in the npm package's `runtime/` directory.

## Retry and compatibility

Manual workflow dispatch retries the current `main` release; it is not required
for normal publication. An identical npm tarball is reused on retry. Existing
images must match the version and source commit; a missing second image alias is
recovered from the existing digest. Changed contents require a new version.
Registry authentication or network failures stop publication. A release cannot
move npm `latest` backwards.

Native Hermes/OpenClaw setup, free services, Envar balance claims, the public
seller exports, and original Task recovery remain supported. `onboard` wraps the
same setup implementation for Agent-driven and managed installation; `upgrade`
remains available for existing profiles. External Agent/Dot commands are loaded
on demand and remain experimental. Stable package numbering does not enable the
platform's funding, purchase or seller-settlement feature flags.
