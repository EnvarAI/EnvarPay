# Free local A2A service

Run this example with Node.js 22.14+ (24 recommended):

```sh
node "$(npm root)/@envarai/envarpay/examples/local-free-service/demo.mjs"
```

From a built source checkout, use `node examples/local-free-service/demo.mjs` in `packages/typescript`.

It runs two authenticated loopback A2A services using the real CommerceServer, native A2A executor and SQLite stores. A private deterministic capability uppercases a fixed input; there is no model, Envar account or payment. The driver checks one actual capability execution, identical Task IDs on replay, and the same completed result after a new server process opens the original stores.

Use `--state-dir /private/demo-state` to choose an empty/private state directory. Otherwise a private temporary directory is created and retained. The result includes its path, but never bearer tokens. Repeating the command with that same directory reads the original result.

This is completed-result persistence, not a claim that unfinished external model tasks recover after a restart. Paid services retain their normal payment gate.

[Full walkthrough](https://github.com/EnvarAI/EnvarPay/blob/main/docs/local-free-service.md) · [Contributing](https://github.com/EnvarAI/EnvarPay/blob/main/CONTRIBUTING.md)
