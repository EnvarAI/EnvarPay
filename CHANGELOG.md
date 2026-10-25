# Changelog

## 2026.1025.1

- Publish stable calendar versions to npm `latest` after main-branch validation.
- Use one container build for standalone and managed deployments, preserving both image names.
- Remove archived payment material and unused wallet client/test remnants.
- Package the required Hermes Python helpers under `runtime/`, separate from examples.
- Load experimental external Agent adapters only for their CLI commands.
- Preserve Envar balance claims, original orders, task recovery and existing public seller APIs.
