# Bounded official A2A TCK check

On 2026-10-05 (Asia/Shanghai), the selected official A2A 1.0 TCK subset against
the local 0.2.0-alpha.3 commerce seller returned **30 passed, 0 failed, 0 skipped**.
The initial run returned **26 passed, 4 failed, 0 skipped** and identified two
HTTP boundary defects. The same unchanged selection passed after those fixes.
This is a bounded compatibility result, not full protocol certification.

## Pinned inputs

- Official TCK: [`a2aproject/a2a-tck` at
  `263b9cfaf16a554bdfb166a7ba5b67716e946349`](https://github.com/a2aproject/a2a-tck/tree/263b9cfaf16a554bdfb166a7ba5b67716e946349),
  package version `1.0.0`, dependencies installed with `uv sync --frozen`.
- Its specification manifest names `v1.0.0` at A2A commit
  [`173695755607e884aa9acf8ce4feed90e32727a1`](https://github.com/a2aproject/A2A/tree/173695755607e884aa9acf8ce4feed90e32727a1/specification).
- Initial product: the EnvarPay 0.2.0-alpha.2 working candidate based on
  `942fb01ca4e8ef4633ebfecdac155026d87ae760`.
- Fixed product: 0.2.0-alpha.3 candidate on `codex/a2a-wire-conformance`, based on
  `38213220219448e8034e202cc807367e43c18d8d`, with the compiled `CommerceServer`
  and `CommerceStore`, official `@a2a-js/sdk 1.2.1`, Node 24.13.0.
- Only an ephemeral free service and local SQLite directory were used. No signer,
  facilitator, chain, PSP, real Agent or model was contacted.

The test host selected the existing `summary-preview` free offer. It served that
offer's unchanged Card at the TCK-required `/.well-known/agent-card.json`, normalized
an added trailing slash on the selected `/a2a/` path, and provided one fixed local
caller through the runtime's authentication callback. Requests and error responses
otherwise passed through the product handler. These accommodations mean the run
does **not** validate production Card discovery, bearer authentication, owner
isolation or arbitrary deployment routing. They do not rewrite the failing header
or response behavior.

## Selection and command

The selected tests exercise Card structure, declared JSON-RPC binding, error
structure, nonexistent Task reads, unsupported capabilities, input rejection and
version/content-type errors. They were selected before execution. No failed test
was removed to produce a passing summary.

From the pinned TCK checkout, with the disposable seller running:

```sh
uv sync --frozen
uv run python -m pytest \
  tests/compatibility/agent_card/test_agent_card.py \
  tests/compatibility/jsonrpc/test_error_codes.py \
  tests/compatibility/jsonrpc/test_error_info.py \
  tests/compatibility/core_operations/test_error_handling.py::TestCoreErrorStructure::test_error_has_code_and_message_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestCoreInputValidation::test_malformed_request_rejected_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestCapabilityPushNotifications::test_push_not_supported_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestCapabilityStreaming::test_streaming_not_supported_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestCapabilityExtendedCard::test_extended_card_not_supported_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestVersionErrors::test_unsupported_version_returns_error_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestVersionErrors::test_empty_version_treated_as_default_jsonrpc \
  tests/compatibility/core_operations/test_error_handling.py::TestJsonRpcErrorStructure \
  --sut-host http://127.0.0.1:50239 --transport jsonrpc --tb short -q \
  --compatibility-report reports/envar-subset \
  --html reports/envar-pytest.html --self-contained-html \
  --junitxml reports/envar-junit.xml
```

The loopback port is from this particular disposable run; use the new fixture's
port when reproducing. The exact wrapper, selection list, commands, output,
unmodified TCK reports, direct reproductions and product source/build hashes were
retained in the private acceptance workspace at
`/tmp/envar-a2a-tck-263b9cf-review/`, with separate `before-repair/` and
`after-repair/` reports. These local files are evidence from the run,
not installed product commands.

## Results and repaired failures

| Area | Result |
|---|---|
| Card retrieval through the fixture alias and Card/interface schema | 6 passed |
| Selected JSON-RPC error and unsupported-capability checks | 24 passed |
| Selected tests skipped | 0 |

The initial four failures had two underlying causes:

1. Unsupported `A2A-Version: 99.0` returns HTTP 400 with
   `{"error":"A2A-Version 1.0 required"}`. The TCK requires a JSON-RPC error object
   carrying `VersionNotSupportedError` (`-32009`), so two mapping tests fail and a
   third range test cannot read `error.code`. This also fails `VER-SERVER-002`.
2. A `Content-Type: text/plain` request is parsed as JSON. The TCK's text-part
   request then receives `InvalidParamsError` (`-32602`) instead of the expected
   content-type rejection. A separate direct reproduction with a valid service
   data part actually completes the free task under `text/plain`, confirming that
   the media type is not rejected at the boundary.

Both were in the commerce HTTP wrapper before or around the official SDK handler.
The fix maps the SDK's `VersionNotSupportedError` and
`ContentTypeNotSupportedError` through its JSON-RPC mapper, retaining the original
request ID and standard `google.rpc.ErrorInfo`. Unsupported versions and request
media types are rejected before any quote, payment gate or task dispatch. Normal
`application/json` parameters and case variations remain accepted. Direct
reproductions now return `-32009` and `-32005`, respectively; the unchanged 30-test
selection passes. Product regression tests additionally prove no order, payment
gate call or execution is created for these invalid requests.

The TCK's aggregate percentage counts requirements that were not selected. It is
not a meaningful product compatibility percentage for this bounded run; the
pytest/JUnit selected-case totals above are the relevant result. Several tests
map to the same requirement ID, so case totals and unique-requirement totals differ.

## Unverified or unsupported scope

The broader TCK includes scenario-triggered tasks, text-only message conventions,
streaming, push notifications, cancellation, extended cards and other transports.
This service accepts one schema-validated data part and does not advertise those
optional transports/capabilities. Its commerce contracts, access controls,
continuation boundaries, payment-before-execution behavior and receipt recovery
are covered by separate product tests and acceptance evidence. They are not
established by this Card/error subset, and the fixture must not be expanded to
fake a capability merely to pass the full generated-scenario suite.

Real payment and native model acceptance are separate from all TCK results. This
run neither spends money nor establishes chain settlement, real task quality,
external interoperability certification or full A2A conformance.
