# Publishing Python legacy documentation maintenance

This is a narrowly scoped release recipe, not a restored Python development
branch. Current seller and connector development stays in TypeScript.

## Immutable baseline and version choice

The manifest [python-release.json](python-release.json) pins the original PyPI
sdist and wheel URLs and SHA-256 digests, the original source commit, and the
target version 0.1.0a12. The PyPI description comes from
[PYPI_README.md](PYPI_README.md).

PEP 440 permits a post-release of an alpha, but recommends incrementing the
alpha number rather than using a harder-to-read aN.postM identifier. This
maintenance therefore remains an alpha at 0.1.0a12; it does not announce a stable
Python runtime. See [the version specification](https://packaging.python.org/en/latest/specifications/version-specifiers/#post-releases).

The builder downloads and verifies both original artifacts, extracts only safe
source members into a temporary directory, changes the two readmes and selected
project metadata, then runs the normal Python build backend. The distribution
verification fails on any changed installed package byte, dependency/extra,
Python requirement, entry point, license notice or unexpected source file.

## Build and inspect without publishing

Use an isolated Python 3.13 environment (Python 3.12 also works for the recipe):

~~~sh
python3 -m venv /private/legacy-release-tools
/private/legacy-release-tools/bin/python -m pip install --index-url https://pypi.org/simple build==1.6.1 hatchling==1.33.0 twine==7.0.0
/private/legacy-release-tools/bin/python -m unittest discover -s scripts/legacy_python/tests
/private/legacy-release-tools/bin/python scripts/legacy_python/release.py --output-dir /private/legacy-release-output
~~~

The output directory must be empty. It contains two distributions under dist/
and verification.json containing source/built hashes and payload comparisons.
The optional --cache-dir must contain the exact hash-pinned original files.
The build does not import the signer, call an Agent, start a wallet or pay anyone.

## Trusted Publisher and manual release

The original 0.1.0a11 PyPI provenance records:

| Setting | Value |
| --- | --- |
| PyPI project | envarpay |
| GitHub repository | EnvarAI/EnvarPay |
| Workflow filename | publish-python.yml |
| GitHub environment | pypi |

The restored workflow intentionally keeps that filename and environment. Its
public history proves the previous mapping, not that today's PyPI owner has
retained it. If it has been removed, a PyPI project owner must re-add this exact
Trusted Publisher. No long-lived upload token is needed when OIDC is configured.
See [PyPI's configuration requirements](https://docs.pypi.org/trusted-publishers/adding-a-publisher/).

The workflow builds on relevant PRs and supports manual dry runs. Publication
requires all of: a manual dispatch from main, publish=true, the completed build/
verification job, GitHub environment access, and PyPI's matching publisher.
Only the publish job receives id-token: write. No PR, tag push, npm release or
normal merge publishes Python.

After the reviewed changes have merged, first run a dry build:

~~~sh
gh workflow run publish-python.yml --repo EnvarAI/EnvarPay --ref main -f publish=false
~~~

Inspect the workflow head SHA, verification.json, artifact hashes and rendered
PyPI readme. Then the authorized operator may dispatch the same reviewed main
revision with publish=true and expected_revision set to that full commit SHA.
The workflow rejects a publication if main has moved to another revision.
Do not set skip-existing or silently replace a
conflicting version. If that version already exists, read its hashes and
provenance and resolve the conflict before choosing another release.

After publication, independently read the version-specific PyPI JSON and
description, compare both uploaded digests with verification.json, verify the
documentation URLs, and inspect installation/version from the wheel in a
separate environment. This confirms distribution and metadata only, not live
payment execution or production acceptance.
