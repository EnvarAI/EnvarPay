import asyncio
import copy
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import httpx
import pytest
from test_payments import sign

from envarpay.config import Connection
from envarpay.storage import PaymentError, Store
from envarpay.wallet import WalletService


async def test_lost_response_recovers_paid_result_without_resigning(
    config, paid_server, monkeypatch
):
    server, verify, settle = paid_server
    config.wallet.peers["seller"].recovery = True

    class Peer:
        lose = True

        async def call_tool(self, name, arguments, meta=None, **kwargs):
            reply = await server.call(name, arguments, meta or {})
            if meta and meta.get("x402/payment") and self.lose:
                self.lose = False
                raise TimeoutError("response lost after delivery")
            return reply

    peer = Peer()

    @asynccontextmanager
    async def connect(*args):
        yield peer

    monkeypatch.setattr("envarpay.wallet.connect", connect)
    wallet = WalletService(config)
    wallet.chain.check_network = AsyncMock()
    with pytest.raises(PaymentError):
        await wallet.call("seller", "ask_agent", {"question": "test"}, "lost-response")
    original = copy.deepcopy(wallet.store.get("buy:lost-response")["data"]["payload"])
    reopened = WalletService(config)
    reopened.chain.prove = AsyncMock(return_value={"transaction": "verified-original"})
    result = await reopened.recover("lost-response")
    assert result["payment_made"] and result["result"]["structuredContent"]["answer"]
    assert await reopened.recover("lost-response") == result
    assert reopened.store.get("buy:lost-response")["data"]["payload"] == original
    assert reopened.store.get("buy:lost-response")["amount"] == 10000
    assert verify.call_count == settle.call_count == 1
    server.backend.call.assert_awaited_once()


async def test_recovery_after_settlement_before_execution(config, paid_server, quote):
    server, _, settle = paid_server
    payload = await sign(config, quote)
    payment = payload.model_dump(mode="json", by_alias=True)
    server.chain.prove.side_effect = PaymentError("RPC temporarily unavailable")
    first = await server.call(
        "ask_agent",
        {"question": "test"},
        {"envarpay/recovery-token": "t" * 40, "x402/payment": payment},
    )
    assert first.isError and settle.call_count == 1
    server.backend.call.assert_not_called()
    server.chain.prove.side_effect = None
    request = {
        "tool": "ask_agent",
        "arguments": {"question": "test"},
        "payment": payment,
        "recover": True,
        "recovery_token": "t" * 40,
    }
    recovered = await server.payment_status(request)
    assert recovered["status"] == "completed"
    assert not recovered["result"]["isError"]
    assert settle.call_count == 1
    server.backend.call.assert_awaited_once()
    changed = {**request, "arguments": {"question": "another task"}}
    with pytest.raises(PaymentError, match="exact request"):
        await server.payment_status(changed)


async def test_canceled_execution_stays_unknown_and_is_not_repeated(config, paid_server, quote):
    server, _, settle = paid_server
    payload = await sign(config, quote)
    payment = payload.model_dump(mode="json", by_alias=True)
    server.backend.call.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await server.call(
            "ask_agent",
            {"question": "test"},
            {"envarpay/recovery-token": "t" * 40, "x402/payment": payment},
        )
    status = await server.payment_status(
        {
            "tool": "ask_agent",
            "arguments": {"question": "test"},
            "payment": payment,
            "recover": True,
            "recovery_token": "t" * 40,
        }
    )
    assert status["status"] == "unknown"
    assert status["payment_state"] == "confirmed"
    assert status["execution_state"] == "unknown"
    assert settle.call_count == 1
    server.backend.call.assert_awaited_once()


async def test_concurrent_recovery_claims_execution_once(config, paid_server, quote):
    server, _, settle = paid_server
    payload = await sign(config, quote)
    payment = payload.model_dump(mode="json", by_alias=True)
    server.chain.prove.side_effect = PaymentError("delay verification")
    await server.call(
        "ask_agent",
        {"question": "test"},
        {"envarpay/recovery-token": "t" * 40, "x402/payment": payment},
    )
    server.chain.prove.side_effect = None
    started, release = asyncio.Event(), asyncio.Event()
    answer = server.backend.call.return_value

    async def execute(*args):
        started.set()
        await release.wait()
        return answer

    server.backend.call.side_effect = execute
    request = {
        "tool": "ask_agent",
        "arguments": {"question": "test"},
        "payment": payment,
        "recover": True,
        "recovery_token": "t" * 40,
    }
    first = asyncio.create_task(server.payment_status(request))
    await asyncio.wait_for(started.wait(), 2)
    other = await server.payment_status(request)
    assert other["status"] == "executing"
    release.set()
    assert (await first)["status"] == "completed"
    assert settle.call_count == 1
    server.backend.call.assert_awaited_once()


def connected(config, tmp_path):
    token = tmp_path / "envar.token"
    token.write_text("envar_agent_" + "x" * 40)
    token.chmod(0o600)
    config.connection = Connection(agent_id=str(uuid.uuid4()), token_file=str(token))
    peer = config.wallet.peers["seller"]
    peer.agent_id, peer.endpoint_id = str(uuid.uuid4()), str(uuid.uuid4())
    return config


async def test_reporter_retries_events_without_repeating_payment(
    config, paid_server, wire, tmp_path, monkeypatch
):
    wallet = WalletService(connected(config, tmp_path))
    wallet.chain.check_network = AsyncMock()
    wallet.chain.prove = AsyncMock(return_value={"transaction": "original"})
    wallet.envar.request = AsyncMock(side_effect=httpx.ConnectError("offline"))
    result = await wallet.call("seller", "ask_agent", {"question": "test"}, "report-outage")
    assert result["payment_made"]
    pending = wallet.store.pending_reports()
    event_ids = [e["event_id"] for e in pending[0]["data"]["outbox"]]
    assert len(event_ids) == 3
    assert {e["kind"] for e in pending[0]["data"]["outbox"]} == {
        "buyer_started",
        "payment_observed",
        "buyer_received",
    }

    async def request(method, path, **kwargs):
        return {"id": str(uuid.uuid4())} if path == "/api/v1/invocations" else {"accepted": True}

    wallet.envar.request = AsyncMock(side_effect=request)
    assert (await wallet.envar.flush())["delivered"] == 3
    assert (await wallet.envar.flush())["delivered"] == 0
    reports = [
        c.kwargs["body"]["event_id"]
        for c in wallet.envar.request.call_args_list
        if c.args[1].endswith("/reports")
    ]
    assert reports == event_ids
    _, verify, settle = paid_server
    assert verify.call_count == settle.call_count == 1
    assert await wallet.call("seller", "ask_agent", {"question": "test"}, "report-outage") == result


async def test_directory_candidates_do_not_change_purchase_policy(config, tmp_path):
    wallet = WalletService(connected(config, tmp_path))
    policy = copy.deepcopy(config.wallet.model_dump())
    wallet.envar.request = AsyncMock(
        return_value={"items": [{"handle": "unapproved", "id": str(uuid.uuid4())}]}
    )
    found = await wallet.envar.search("research")
    assert not found["payment_authorized"]
    assert config.wallet.model_dump() == policy
    with pytest.raises(PaymentError, match="allowlist"):
        wallet.peer("unapproved", "ask_agent")


def test_acknowledging_reports_does_not_overwrite_concurrent_payment_state(tmp_path):
    store = Store(str(tmp_path / "state"))
    store.claim("buy:one", "binding", {})
    store.queue_event("buy:one", "buyer_started", {})
    event = store.pending_reports()[0]["data"]["outbox"][0]
    store.update("buy:one", "completed", result={"answer": "done"})
    store.update("buy:one", None, invocation_id=str(uuid.uuid4()))
    store.acknowledge_event("buy:one", event["event_id"])
    assert store.get("buy:one")["status"] == "completed"
    assert store.get("buy:one")["data"]["result"] == {"answer": "done"}


async def test_public_chain_authorization_does_not_grant_private_result(config, paid_server, quote):
    server, _, _ = paid_server
    payload = await sign(config, quote)
    payment = payload.model_dump(mode="json", by_alias=True)
    original = await server.call(
        "ask_agent",
        {"question": "test"},
        {"x402/payment": payment, "envarpay/recovery-token": "private_" + "r" * 40},
    )
    assert not original.isError
    replay = await server.call("ask_agent", {"question": "test"}, {"x402/payment": payment})
    assert replay.isError
    assert "test-double answer" not in str(replay)
    for token in ("", "wrong_" + "r" * 40):
        response = await server.call(
            "envarpay_payment_status",
            {
                "tool": "ask_agent",
                "arguments": {"question": "test"},
                "payment": payment,
                "recover": True,
                "recovery_token": token,
            },
            {},
        )
        assert response.isError
        assert "test-double answer" not in str(response)
    server.backend.call.assert_awaited_once()
