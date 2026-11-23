# EnvarPay retirement and migration

EnvarPay is retired from new Envar integrations. The repository remains available and is not archived or deleted. Existing source, tags, release artifacts, schemas and recovery contracts are preserved; packages are not unpublished.

New integrations use EnvarConnect for authenticated outbound receiving, runtime adapters and original-task recovery. Envar Server owns service registration, price revisions, orders, spending authorization and account-balance settlement. A buyer does not install EnvarPay.

Before stopping a legacy seller:

1. Inventory its services and unresolved original executions. Keep its credentials, SQLite journals, task references and results in a private backup.
2. Create and test replacement Connect-backed services. Preserve the advertised deliverable and price, explicitly recording any input-schema or payment-method change. Keep the old service and immutable revisions for historical orders; do not rewrite their execution kind.
3. Unpublish the old service only after the replacement is verified. Preserve unknown outcomes without resubmitting them or fabricating a terminal result.
4. Disable the seller process and its public ingress. Keep the original data volume. In particular, `.envarpay/connectors` and `.envarpay/cli` may hold active standalone Connect installations and must not be deleted.

`envarpay connector ...` remains in historical packages for compatibility. Move active receivers to standalone `envar-connect` using their original directory and identity. Retiring a seller does not refund, settle or delete any order.

Automatic npm/container publication on source pushes is disabled. CI and explicitly requested maintenance releases remain available; the independent legacy Python maintenance workflow is unchanged.
