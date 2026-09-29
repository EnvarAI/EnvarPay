# Cross-framework payment validation

**2026-09-29: 28/30 real paid deliveries passed; two settlements failed.**

All six frameworks acted as buyer and seller in local Docker, using official development-branch commits frozen at the start of this run. This is not a 30/30 pass or a production-release approval.

[Public audit JSON](../evidence/2026-09-29-matrix.json) · [Source commits](../../examples/cross-framework/sources.json) · [Docker recipes and native adapters](../../examples/cross-framework/README.md)

## Directed payment matrix

Rows are buyers; columns are sellers. Each **paid** link is a distinct Base Sepolia transaction. A dash is the same framework, excluded from this matrix.

| Buyer → Seller | OpenClaw | Hermes | OpenCode | Goose | LangGraph | Pydantic AI |
|---|---|---|---|---|---|---|
| OpenClaw | — | [paid](https://sepolia.basescan.org/tx/0x7e091cd32470332ed61bbaf1fd953c282a6538bd4cf5711fb5f70b6834f8fb3f) | [paid](https://sepolia.basescan.org/tx/0x63c976e96ec1a91353e76c22bc862597264234d3f9394f7b386be70f2095eeed) | [paid](https://sepolia.basescan.org/tx/0xd79dd18efb0dcaa54c6df722a5e8998b0d5fe34f17ededc63b89f6f8684a5122) | [paid](https://sepolia.basescan.org/tx/0x6768f79b9ebe465acf20600bc61c63e0768680432aebb5307b64675e6e8c2f87) | **failed** |
| Hermes | [paid](https://sepolia.basescan.org/tx/0x3dc94b9f71a4c2367d903f628c2e37f7605b9966bed466aadabc2eefb8af2241) | — | [paid](https://sepolia.basescan.org/tx/0x4228e908361ae558ba0f526699cf9b4c9cf8007f72afb21c3caa67c93bd9903e) | [paid](https://sepolia.basescan.org/tx/0x070898d037fc04a070633d5ad71bfee366d5c82ba278cd6f4c0416781b6cb940) | **failed** | [paid](https://sepolia.basescan.org/tx/0x06ae061df58e647560b8cf312a696dba5ecb59a6d48ef3625a27dd9962e1a01f) |
| OpenCode | [paid](https://sepolia.basescan.org/tx/0x0f86e4423f1311a82c7f386c6cf176b8d6908d914e915f98fdc0a2310ab9740e) | [paid](https://sepolia.basescan.org/tx/0xbf95f5c391f29c7936c2433f841570952d754062a53bf455852e12d8946956f9) | — | [paid](https://sepolia.basescan.org/tx/0x2ca31cda1990177b1be783501172ba465280e839c72a40018b12ea27dcc0e5ae) | [paid](https://sepolia.basescan.org/tx/0x873847a9ddcd2c0d03a68d060e6e0ca48c16625b43186038690b6938da06f8ef) | [paid](https://sepolia.basescan.org/tx/0x0f6007923f7df5d8587d314b427b8d832df0af93ec9023c3fadc0911334ca9d4) |
| Goose | [paid](https://sepolia.basescan.org/tx/0x56d7249ba7ca7ed56faf4a6b5bb988d271188ce0306f9b50f511bec789e24407) | [paid](https://sepolia.basescan.org/tx/0x523883c4f5fc6c76c72d2c38f116ecbd49724812a0ed2d7efaee43caa238ffa6) | [paid](https://sepolia.basescan.org/tx/0x0d32a1a25b8b6db585ec27216579c05c256e89dae6e66cc00e30f75e99005913) | — | [paid](https://sepolia.basescan.org/tx/0xcb1d916395da8e1d68e6af9399f4548296641ea8eced68c28d3a2e5335928684) | [paid](https://sepolia.basescan.org/tx/0xc9f4b0b94d649bbcd3b489c3cc2ba196105d94835238c530ab1ce9c582341aab) |
| LangGraph | [paid](https://sepolia.basescan.org/tx/0x27c0c95efd164fd6afa4fb9983b5e17c51a057d1d82ce53fc0c79f52b76ff3b4) | [paid](https://sepolia.basescan.org/tx/0x2408ca30953f7be3b2e5934d280e0996ba0d5ae129c54a37253baa8b16e97ed2) | [paid](https://sepolia.basescan.org/tx/0x0f44d808f89aefdcba78b4d11fdff95faceb95eed38dc2fe45095fe9c11fd25a) | [paid](https://sepolia.basescan.org/tx/0xf8e20606b37fb183473360ee6cd1261eaa07578f66d5a2f0cd808dc7163b31e0) | — | [paid](https://sepolia.basescan.org/tx/0xe28539aec28eef0ad80ea6147ad9ca8880ee8e858f96dc3f47aba139e467a0d8) |
| Pydantic AI | [paid](https://sepolia.basescan.org/tx/0x2e2bc3de904f7da8c2eb11304d1f2a25636dd2c1cb5cee218408ed5c26ea8f29) | [paid](https://sepolia.basescan.org/tx/0x9df373dd67175a82feab2edd3859d6fd1fedb67eabe5e6ceadee9e874eb2c92a) | [paid](https://sepolia.basescan.org/tx/0x7128c7d6cc2c319810e8d2bb248d28244cc34edad8e8b606e55bb310fe99852c) | [paid](https://sepolia.basescan.org/tx/0x49aa56de9ad4b81a25ffe3f567a749ab721344bb2760f7c0a3ac72f6421d4dae) | [paid](https://sepolia.basescan.org/tx/0x88b06eb0bc5f39726e530365ed36b8b62404a4aa2c431bc24c742ae95e47c3dc) | — |

Each payment is **100 atomic = 0.0001 test USDC**, network `eip155:84532`, official token `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. The 28 purchases total **0.0028 test USDC**. Six 500-atomic wallet-funding transfers are separate and do not count as agent delivery.

## Evidence checked for every successful direction

1. The native buyer model dispatched `call_paid_tool` through the named framework’s own tool loop, with the original request ID and exact arguments.
2. The paid seller and buyer ledgers contain the same authorization and delivered result. Each nonce and transaction is unique.
3. An independent raw-RPC audit checked chain ID, successful receipt, canonical block, confirmations, exact USDC Transfer and matching AuthorizationUsed nonce. It does not call the SDK receipt validator.
4. The native seller started once, after the payment gate verified the receipt. Its actual result reached the native buyer.
5. Replaying the completed request ID returned the saved result without a second payment or seller execution. Each raw seller remains on its private Docker network, with no host port.

The task was `17 × 19` with a unique result marker. JSON preserves the **actual seller and buyer text**, which can include extra prose, separately from `expected_marker`. This proves bounded paid execution, not the quality of arbitrary agent work. Each seller also returned standard PaymentRequired before payment without starting the task.

## Two failed settlements

| Direction | Facilitator response | Seller executions | State |
|---|---|---|---|
| Hermes → LangGraph | `invalid_exact_evm_transaction_failed`, empty transaction hash | 0 | Original authorization and 100-atomic reservation retained |
| OpenClaw → Pydantic AI | Same error and empty hash | 0 | Original authorization and 100-atomic reservation retained |

The public facilitator reported failure, but supplied no transaction hash to diagnose its underlying transaction error. Do not infer a specific gas/nonce/provider root cause from that message alone. The SDK kept buyer operations `unknown` and prevented the sellers from executing.

At the audit snapshot, both original nonces were unused at a latest block after their authorization expiry. The finalized block was still before expiry, so that snapshot is **not finalized proof of non-payment**. Original request IDs, signed payloads and cumulative budgets were preserved. No replacement signature, settlement retry or ledger clearing was performed.

The current `reconcile` command checks an already recorded transaction; it does not recover a missing hash, release a failed budget or authorize a new purchase. Completing these two directions requires first conclusively reconciling the original nonces, then an explicitly authorized new test purchase. Changing IDs/budgets to bypass an unresolved attempt is not recovery.

## Source and environment

| Framework | Official branch | Source commit |
|---|---|---|
| langgraph | `main` | [07b33185eab8](https://github.com/langchain-ai/langgraph/commit/07b33185eab893be2ed031eedae52f09314bf77c) |
| openclaw | `main` | [aa56d37f1c81](https://github.com/openclaw/openclaw/commit/aa56d37f1c81c25d856eabfde479b4352763d154) |
| langchain | `master` | [ce9066138d0e](https://github.com/langchain-ai/langchain/commit/ce9066138d0e234109ac7dd60a10ad7cc10cdfda) |
| pydantic-ai | `main` | [3b68c695b106](https://github.com/pydantic/pydantic-ai/commit/3b68c695b1068736133b7018f9c69d14ce390d38) |
| hermes | `main` | [fc042f1d67bc](https://github.com/NousResearch/hermes-agent/commit/fc042f1d67bc393bf43920e92d4eb5082eddedfb) |
| opencode | `dev` | [7945de208964](https://github.com/anomalyco/opencode/commit/7945de208964a49300d7f770d1a71d078db9a4c4) |
| goose | `main` | [b92a80daf4a7](https://github.com/aaif-goose/goose/commit/b92a80daf4a77d7e854709965bdfdc489c0472d2) |

Full Docker image IDs and harness hashes are included in the audit JSON. OpenClaw’s binary version label is 2026.9.6, but it was built from the recorded main commit; the host’s old 2026.4.2 installation was not used. Hermes executes the recorded source under `/opt/hermes-latest`, not the base image’s old installation.

CI [built runtime artifacts](https://github.com/EnvarAI/EnvarPay/actions/runs/36573863380); those builds are not payment evidence. Unchanged OpenCode and Pydantic source artifacts from [the prior build](https://github.com/EnvarAI/EnvarPay/actions/runs/36567429668) were also used. The SDK container reused a previously verified dependency layer with the renamed wheel. It is not a clean-install test.

## Compatibility fixes and boundaries

- OpenClaw: current `agents.entries` / `memory.search` config; persistent profile and workspace; native MCP tool traces checked from the runtime’s session store.
- Hermes: current main source in its own Python environment, native MCP client, dedicated model-key variable.
- OpenCode and Goose: native headless CLI loops and MCP extensions; Goose now has a `host-config` generator.
- LangGraph/LangChain and Pydantic AI: separate FastMCP 4/MCP 2 environments, official legacy negotiation against the MCP 1 wallet.
- Local SDK checks: **77 tests passed**, including real local TCP MCP transports; Ruff lint/format, sdist/wheel build, clean host wheel installation, dependency consistency and four host-config smoke checks passed. These checks make no payment and are not counted in the matrix.

The paid acceptance path is **MCP gate + native CLI/framework adapter**. Existing OpenClaw/Hermes Gateway HTTP connectors remain experimental and need separate live acceptance. Dedicated test containers share the runtime/wallet OS identity; this is not a custody-isolation guarantee. There is no mainnet test, automatic refund, quality guarantee, multi-host state coordination or new PyPI publication.

The older [two-Hermes POC](../proof-of-concept.md) is separate history and is not counted again.
