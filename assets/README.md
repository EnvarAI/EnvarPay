# README visuals

Repository Markdown embeds committed SVGs, so rendering does not depend on a
live Mermaid parser or an external badge host. The CI badge links to the live
workflow; its static text does not claim a passing status.

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
