# README visuals

The banner and payment-flow diagram are committed SVGs, so the diagram does not
depend on GitHub's live Mermaid parser.

README badges use GitHub Actions and [Shields.io](https://shields.io/):

- CI reports the actual `ci.yml` workflow status on `main`.
- License and latest GitHub release (including prereleases) come from repository metadata.
- Python is a Shields.io static badge for the supported version in `pyproject.toml`;
  update it when `requires-python` changes.

Do not replace these with local status images. Add PyPI/npm version badges only
after the corresponding packages are actually published.

Edit `payment-flow.mmd`, then regenerate the SVG with Mermaid CLI:

```sh
npx --yes @mermaid-js/mermaid-cli@11.17.0 \
  -i assets/payment-flow.mmd -o assets/payment-flow.svg \
  -c assets/mermaid-config.json -b white
```

Inspect the rendered image before committing it. Avoid literal semicolons in
sequence-message labels: they can be interpreted as statement delimiters.
The original failing message was `Check recipient and budget; sign`.

PyPI uses a separate text-first `README.pypi.md`, with absolute documentation
links and no Mermaid or relative image URLs.
