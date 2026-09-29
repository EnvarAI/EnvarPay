import asyncio
from unittest.mock import AsyncMock

import pytest
from eth_account import Account
from x402 import x402Client
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.schemas import PaymentRequired

from envarpay.storage import PaymentError
from envarpay.wallet import WalletService


async def sign(config, quote):
    client = x402Client().register(config.network, ExactEvmClientScheme(Account.create()))
    return await client.create_payment_payload(PaymentRequired.model_validate(quote))


async def test_unpaid_and_invalid_input_never_execute(paid_server):
    server, verify, settle = paid_server
    unpaid = await server.call("ask_agent", {"question": "test"}, {})
    assert unpaid.isError and unpaid.structuredContent["x402Version"] == 2
    invalid = await server.call("ask_agent", {"question": 7}, {})
    assert invalid.isError
    server.backend.call.assert_not_called()
    assert not verify.called and not settle.called


async def test_upfront_sequence_and_exact_replay(config, paid_server, quote):
    server, verify, settle = paid_server
    payload = await sign(config, quote)
    meta = {
        "envarpay/recovery-token": "t" * 40,
        "x402/payment": payload.model_dump(mode="json", by_alias=True),
    }
    order = []

    async def prove(*args):
        assert settle.called
        order.append("receipt")
        return {"transaction": "proof"}

    answer = server.backend.call.return_value

    async def execute(*args):
        order.append("execute")
        return answer

    server.chain.prove.side_effect = prove
    server.backend.call.side_effect = execute
    first = await server.call("ask_agent", {"question": "test"}, meta)
    assert not first.isError and first.meta["x402/payment-response"]["success"]
    assert first.meta["upstream"] == "preserved"
    assert order == ["receipt", "execute"]
    replay = await server.call("ask_agent", {"question": "test"}, meta)
    assert replay == first
    mismatch = await server.call("ask_agent", {"question": "changed"}, meta)
    assert mismatch.isError and "different arguments" in mismatch.content[0].text
    assert verify.call_count == settle.call_count == 1
    server.backend.call.assert_awaited_once()


async def test_no_work_when_chain_proof_fails(config, paid_server, quote):
    server, _, settle = paid_server
    payload = await sign(config, quote)
    server.chain.prove.side_effect = PaymentError("Receipt mismatch")
    result = await server.call(
        "ask_agent",
        {"question": "test"},
        {"envarpay/recovery-token": "t" * 40, "x402/payment": payload.model_dump(by_alias=True)},
    )
    assert result.isError and settle.called
    server.backend.call.assert_not_called()
    record = server.store.get(server.payment_key(payload))
    assert record["data"]["transaction"]


async def test_existing_http_runtime_waits_for_proof_and_is_not_replayed(
    config, paid_server, quote, respx_mock, monkeypatch
):
    from envarpay.backend import AgentBackend
    from envarpay.config import Backend

    server, _, _ = paid_server
    monkeypatch.setenv("ENVARPAY_TEST_GATEWAY_TOKEN", "test-token")
    server.backend = AgentBackend(
        Backend(
            kind="http",
            model="openclaw/seller",
            base_url="http://127.0.0.1:18789/v1",
            api_key_env="ENVARPAY_TEST_GATEWAY_TOKEN",
        ),
        30,
    )
    upstream = respx_mock.post("http://127.0.0.1:18789/v1/responses").respond(
        json={
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "test-double runtime answer"}],
                }
            ],
        }
    )
    proving, release = asyncio.Event(), asyncio.Event()

    async def proof(*args):
        proving.set()
        await release.wait()
        return {"test_double": True}

    server.chain.prove.side_effect = proof
    unpaid = await server.call("ask_agent", {"question": "test"}, {})
    assert unpaid.isError and not upstream.called
    payload = await sign(config, quote)
    meta = {"envarpay/recovery-token": "t" * 40, "x402/payment": payload.model_dump(by_alias=True)}
    first = asyncio.create_task(server.call("ask_agent", {"question": "test"}, meta))
    await asyncio.wait_for(proving.wait(), 3)
    assert not upstream.called
    release.set()
    result = await first
    assert not result.isError and upstream.call_count == 1
    assert await server.call("ask_agent", {"question": "test"}, meta) == result
    assert upstream.call_count == 1


async def test_invalid_signature_cannot_reserve_nonce(config, paid_server, quote):
    server, verify, settle = paid_server
    payload = await sign(config, quote)
    verify.respond(200, json={"isValid": False, "invalidReason": "invalid_signature"})
    result = await server.call(
        "ask_agent",
        {"question": "test"},
        {
            "x402/payment": payload.model_dump(by_alias=True),
        },
    )
    assert result.isError and not settle.called
    assert server.store.get(server.payment_key(payload)) is None
    server.backend.call.assert_not_called()


@pytest.mark.parametrize("field,value", [("to", "0x" + "66" * 20), ("value", "1")])
async def test_seller_requires_exact_authorized_price(config, paid_server, quote, field, value):
    server, verify, settle = paid_server
    payload = await sign(config, quote)
    payload.payload["authorization"][field] = value
    result = await server.call(
        "ask_agent",
        {"question": "test"},
        {
            "x402/payment": payload.model_dump(by_alias=True),
        },
    )
    assert result.isError and not verify.called and not settle.called
    assert server.store.get(server.payment_key(payload)) is None
    server.backend.call.assert_not_called()


async def test_signature_saved_before_submission_and_storage_failure_stops_send(
    config, paid_server, wire, monkeypatch
):
    wallet = WalletService(config)
    wallet.chain.check_network = AsyncMock()
    original_update = wallet.store.update

    def broken_update(key, status, **data):
        if status == "signed":
            raise OSError("simulated full disk")
        return original_update(key, status, **data)

    monkeypatch.setattr(wallet.store, "update", broken_update)
    with pytest.raises(PaymentError):
        await wallet.call("seller", "ask_agent", {"question": "test"}, "disk-full")
    _, verify, settle = paid_server
    assert not verify.called and not settle.called
    assert wallet.store.get("buy:disk-full")["amount"] == 10000


async def test_duplicate_cannot_overwrite_inflight_settlement(config, paid_server, quote):
    server, _, settle = paid_server
    payload = await sign(config, quote)
    meta = {"envarpay/recovery-token": "t" * 40, "x402/payment": payload.model_dump(by_alias=True)}
    proving, release = asyncio.Event(), asyncio.Event()

    async def proof(*args):
        proving.set()
        await release.wait()
        return {}

    server.chain.prove.side_effect = proof
    first = asyncio.create_task(server.call("ask_agent", {"question": "test"}, meta))
    await asyncio.wait_for(proving.wait(), 3)
    duplicate = await server.call("ask_agent", {"question": "test"}, meta)
    assert duplicate.isError
    release.set()
    assert not (await first).isError
    assert server.store.get(server.payment_key(payload))["status"] == "completed"
    assert settle.call_count == 1


async def test_wallet_real_sdk_signature_cached_result_and_budget(config, paid_server, wire):
    wallet = WalletService(config)
    wallet.chain.check_network = AsyncMock()
    wallet.chain.prove = AsyncMock(return_value={"verified": True})
    result = await wallet.call("seller", "ask_agent", {"question": "test"}, "request-1")
    assert result["payment_made"] and result["payment"]["verified"]
    original = wallet.store.get("buy:request-1")["data"]["payload"]
    assert len(original["payload"]["signature"]) == 132
    reopened = WalletService(config)
    assert await reopened.call("seller", "ask_agent", {"question": "test"}, "request-1") == result
    with pytest.raises(PaymentError, match="different request"):
        await reopened.call("seller", "ask_agent", {"question": "other"}, "request-1")
    with pytest.raises(PaymentError, match="budget"):
        await wallet.call("seller", "ask_agent", {"question": "new"}, "request-2")
    assert wallet.store.get("buy:request-2")["amount"] == 0


async def test_unknown_result_keeps_original_authorization_and_budget(config, paid_server, wire):
    wallet = WalletService(config)
    wallet.chain.check_network = AsyncMock()
    wallet.chain.prove = AsyncMock(side_effect=PaymentError("RPC unavailable"))
    with pytest.raises(PaymentError):
        await wallet.call("seller", "ask_agent", {"question": "test"}, "unknown")
    record = wallet.store.get("buy:unknown")
    assert record["status"] == "unknown" and record["amount"] == 10000
    assert record["data"]["payload"]["payload"]["authorization"]["nonce"]
    with pytest.raises(PaymentError, match="unresolved"):
        await WalletService(config).call("seller", "ask_agent", {"question": "test"}, "unknown")
    with pytest.raises(PaymentError, match="unresolved"):
        await WalletService(config).call("seller", "ask_agent", {"question": "test"}, "new-id")
