# EnvarPay service container

The root Dockerfile runs EnvarPay with its task extra as non-root UID/GID 10001.
It contains the payment gate/wallet/task services; your existing Agent runtime,
model keys and profiles remain separate. Never mount a buyer key into that runtime.

The `Service container` workflow checks Linux amd64 and arm64. Only an explicit
manual publication on `main` can push an immutable `oci-v<VERSION>` tagged source
to `ghcr.io/envarai/envarpay:<VERSION>`. It uses GitHub's short-lived `GITHUB_TOKEN`,
not a wallet key or long-lived registry secret. SBOM/provenance accompany the image.
First publication is private by GitHub default until the package owner enables
public visibility; an anonymous pull is the public-release acceptance gate.

## Published image status

Checked **2026-10-02 UTC**: `ghcr.io/envarai/envarpay:0.1.0a11` was published by
[the successful workflow](https://github.com/EnvarAI/EnvarPay/actions/runs/37025598866).
The multi-platform manifest digest is
`sha256:4751e6cf1d55f9e949578c14236299cb71b17ed732a9eb86beb6417e635cadbb`.
The pulled arm64 image reports EnvarPay a11, Web3 7.16.0 and UID 10001 in an
offline check. **It is not public yet:** GitHub organization policy disables Public
visibility, and anonymous access has not passed. An authorized account can pull
this digest; other users can build the source below or install the public PyPI wheel.

## Run a reviewed image

After verifying the published version/digest, pin the digest in deployment. You
can build the reviewed source locally before registry publication:

```sh
docker build -t envarpay:reviewed .
docker run --rm --network none envarpay:reviewed --version
docker run --rm --network none envarpay:reviewed task --help
```

Mount a private configuration/state directory writable by UID 10001. Preserve
that directory on restart; do not use an ephemeral container filesystem for keys
or the durable ledger. Use a dedicated Docker volume, or provision a private bind
mount with owner UID/GID 10001 on Linux. Do not relax it to world-writable permissions.

```sh
docker run -d --init --name envarpay-gate --restart unless-stopped \
  --network YOUR_PRIVATE_NETWORK -p 127.0.0.1:4020:4020 \
  -v YOUR_PRIVATE_CONFIG_DIR:/config \
  envarpay:reviewed serve --config /config/seller.toml
```

Set the existing seller table's bind host to `0.0.0.0`, allow the intended proxy
Host, and use the private runtime's Docker service name for its MCP upstream.
Expose the gate through HTTPS. A loopback-only host port above prevents direct
network access to the unproxied service. Do not publish the raw Agent capability.

For wallet and task services use their respective CLI subcommands and distinct
config/key/state directories. Keep payment/evaluator signing off until the operator
has reviewed the exact test/mainnet terms. The image does not create a wallet key,
fund an account, authorize payment or enable experimental mainnet task escrow.
[Configuration](configuration.md) · [Task mode](tasks/README.md) · [Operations](operations.md).

## Release

Create a new immutable `oci-v<VERSION>` tag on the reviewed merged commit whose
`pyproject.toml` version matches, then run:

```sh
gh workflow run container.yml --repo EnvarAI/EnvarPay --ref main \
  -f tag=oci-vVERSION -f publish=true
```

Do not move a published tag or overwrite a previously accepted version. Record the
workflow, source revision and multi-platform digest. Check public visibility with
an anonymous registry pull and smoke-test the actual pulled image without network
or signing. Existing wallets upgrade only after retaining their private state and
reviewing the [migration guide](migration-envarpay.md).
