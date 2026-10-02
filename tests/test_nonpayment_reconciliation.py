from unittest.mock import AsyncMock

import pytest

from envarpay.chain import Chain
from envarpay.reconciliation import release_unpaid
from envarpay.storage import PaymentError, Store

AUTH = {
    "from": "0x" + "1" * 40,
    "to": "0x" + "3" * 40,
    "nonce": "0x" + "a" * 64,
    "value": "10000",
    "validBefore": "100",
}
BLOCK = {"number": "0x42", "hash": "0x" + "b" * 64, "timestamp": "0x65"}


async def test_finalized_expired_unused_proof(config):
    chain = Chain(config)
    chain.rpc = AsyncMock(side_effect=[hex(config.chain_id), BLOCK, "0x" + "0" * 64, BLOCK])
    proof = await chain.prove_unused_expired(AUTH)
    assert proof["block_number"] == 66 and proof["used_or_cancelled"] is False
    assert chain.rpc.call_args_list[1].args == ("eth_getBlockByNumber", ["finalized", False])
    assert chain.rpc.call_args_list[2].args[1][1] == BLOCK["number"]


@pytest.mark.parametrize(
    "responses",
    [
        ["0x1"],
        ["0x14a34", None],
        ["0x14a34", dict(BLOCK, timestamp="0x64")],
        ["0x14a34", BLOCK, "0x" + "0" * 63 + "1"],
        ["0x14a34", BLOCK, "0x0"],
        ["0x14a34", BLOCK, "0x" + "0" * 64, dict(BLOCK, hash="0x" + "c" * 64)],
    ],
)
async def test_incomplete_used_wrong_chain_or_changed_block_retains_budget(config, responses):
    chain = Chain(config)
    chain.rpc = AsyncMock(side_effect=responses)
    with pytest.raises(PaymentError):
        await chain.prove_unused_expired(AUTH)


def seed(config, quote):
    terms = quote["accepts"][0]
    store = Store(config.state_dir)
    store.claim("buy:old", "fixed-binding", {"execution_state": "not_started"})
    store.reserve_budget("buy:old", 10000, 50000)
    payload = {
        "accepted": terms,
        "payload": {"authorization": dict(AUTH, to=terms["payTo"]), "signature": "private"},
    }
    store.update("buy:old", "unknown", requirements=terms, payload=payload, payment_state="signed")
    return store, payload


async def test_two_rpc_proofs_release_without_replaying_or_losing_original(
    config, quote, monkeypatch
):
    store, payload = seed(config, quote)
    prove = AsyncMock(return_value={"used_or_cancelled": False})
    monkeypatch.setattr(Chain, "prove_unused_expired", prove)
    result = await release_unpaid(config, "buy:old", "https://independent.example")
    assert result["reservation_released"] and prove.await_count == 2
    row = store.get("buy:old")
    assert row["amount"] == 0 and row["status"] == "refused"
    assert row["data"]["original_reserved_atomic"] == 10000
    assert row["data"]["payload"] == payload
    assert len(row["data"]["nonpayment_proof"]["checks"]) == 2
    assert "signature" not in str(result)
    await release_unpaid(config, "buy:old", "https://independent.example")
    assert prove.await_count == 2
    with pytest.raises(PaymentError):
        store.claim("buy:old", "fixed-binding", {})


async def test_second_rpc_failure_does_not_release(config, quote, monkeypatch):
    store, _ = seed(config, quote)
    monkeypatch.setattr(
        Chain, "prove_unused_expired", AsyncMock(side_effect=[{}, PaymentError("unproven")])
    )
    with pytest.raises(PaymentError):
        await release_unpaid(config, "buy:old", "https://independent.example")
    assert store.get("buy:old")["amount"] == 10000


async def test_concurrent_update_refuses_release(config, quote, monkeypatch):
    store, _ = seed(config, quote)

    async def changed(*args):
        store.update("buy:old", "settled", transaction="0x" + "d" * 64)
        return {}

    monkeypatch.setattr(Chain, "prove_unused_expired", changed)
    with pytest.raises(PaymentError, match="changed"):
        await release_unpaid(config, "buy:old", "https://independent.example")
    assert store.get("buy:old")["amount"] == 10000


async def test_same_rpc_host_and_changed_terms_refused(config, quote, monkeypatch):
    store, _ = seed(config, quote)
    prove = AsyncMock()
    monkeypatch.setattr(Chain, "prove_unused_expired", prove)
    with pytest.raises(PaymentError, match="independently"):
        await release_unpaid(config, "buy:old", config.rpc_url)
    row = store.get("buy:old")
    row["data"]["requirements"]["amount"] = "99999"
    store.update("buy:old", "unknown", requirements=row["data"]["requirements"])
    with pytest.raises(PaymentError, match="terms"):
        await release_unpaid(config, "buy:old", "https://independent.example")
    prove.assert_not_called()
    assert store.get("buy:old")["amount"] == 10000


async def test_reconciled_original_recovery_never_contacts_peer(config, quote, monkeypatch):
    from envarpay.wallet import WalletService

    seed(config, quote)
    monkeypatch.setattr(Chain, "prove_unused_expired", AsyncMock(return_value={}))
    await release_unpaid(config, "buy:old", "https://independent.example")
    contact = AsyncMock(side_effect=AssertionError("must not contact peer"))
    monkeypatch.setattr("envarpay.wallet.connect", contact)
    result = await WalletService(config).recover("old")
    assert result["status"] == "refused" and not result["payment_made"]
    contact.assert_not_called()
