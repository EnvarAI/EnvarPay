# Independent Node commerce container

The 0.2 container runs the TypeScript A2A commerce service on Node 24 as UID/GID
10001. It bundles neither an Agent framework nor a model credential. Build from
reviewed source while the immutable registry release is being accepted:

```sh
docker build -t envarpay:commerce .
docker run --rm --network none envarpay:commerce --version
```

Prepare private files with `envarpay init --directory ./private`, review real
service and wallet settings, then mount only what each role needs. The container
UID must own writable ledger/vault files. Keep signer keys and original payment
credentials inaccessible to the Agent container.

```sh
docker run --name envarpay-seller --restart unless-stopped \
  -p 127.0.0.1:4020:4020 \
  --mount type=bind,src=/absolute/private-seller,dst=/data \
  envarpay:commerce serve --config /data/seller.json \
  --credentials /data/seller-auth.json --state /data/ledger.sqlite3 \
  --origin https://YOUR_SELLER_HOST --host 0.0.0.0 --port 4020
```

The configured origin must match the public reverse proxy's Host. Keep the native
Agent on a private Docker network and advertise the address reachable from the
seller container in its Agent Card. A host loopback address inside a container
points to that container, not the host or a different Agent.

Use a separate container and private directory for `buyer-serve`. It exposes a
Bearer-protected management API, defaults to loopback, and only purchases from
locally allowlisted peers. Publish a management HTTPS endpoint only for the
intended owner/BFF credential; do not expose wallet keys or arbitrary-target proxy
operations.

One process owns each SQLite ledger. Do not scale by sharing one mounted SQLite
file. Preserve the SQLite files, authorizations directory, keys and configuration
as a consistent private backup; uncertain transactions resume with their original
reference. SIGTERM stops new work and allows a bounded drain.

The previous Python/MCP containers remain addressable by their old immutable
tags for recovery of existing experimental operations. They are not the new
A2A commerce runtime. Never overwrite a released tag or migrate an unknown
purchase by signing another payment.
