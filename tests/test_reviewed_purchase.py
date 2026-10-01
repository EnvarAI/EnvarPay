import uuid
from unittest.mock import AsyncMock

import pytest
import tomli_w

from envarpay.config import load_config
from envarpay.onboarding import connect_config
from envarpay.storage import PaymentError
from envarpay.wallet import WalletService


def reviewed(config):
    peer = config.wallet.peers["seller"]
    peer.agent_id, peer.endpoint_id = str(uuid.uuid4()), str(uuid.uuid4())
    return dict(
        agent_id=peer.agent_id,
        endpoint_id=peer.endpoint_id,
        tool="ask_agent",
        arguments={"question": "test"},
        request_id="reviewed-1",
        expected_network=config.network,
        expected_pay_to=peer.pay_to,
        expected_amount_atomic=10000,
    )


async def test_directory_candidate_never_authorizes_a_peer(config):
    args = reviewed(config)
    args["agent_id"] = str(uuid.uuid4())
    wallet = WalletService(config)
    with pytest.raises(PaymentError, match="Approve"):
        await wallet.call_agent(**args)
    assert wallet.store.get("buy:reviewed-1") is None


async def test_reviewed_quote_change_never_signs_or_executes(config, paid_server, wire):
    args = reviewed(config)
    args["expected_amount_atomic"] = 9999
    wallet = WalletService(config)
    with pytest.raises(PaymentError):
        await wallet.call_agent(**args)
    server, verify, settle = paid_server
    assert not verify.called and not settle.called
    server.backend.call.assert_not_called()
    assert wallet.store.get("buy:reviewed-1")["amount"] == 0
    assert wallet.store.get("buy:reviewed-1")["data"].get("payload") is None


async def test_reviewed_purchase_replays_one_original_payment(config, paid_server, wire):
    args = reviewed(config)
    wallet = WalletService(config)
    wallet.chain.check_network = AsyncMock()
    wallet.chain.prove = AsyncMock(return_value={"transaction": "0x" + "11" * 32})
    first = await wallet.call_agent(**args)
    second = await wallet.call_agent(**args)
    assert first == second and first["payment_made"]
    server, _, settle = paid_server
    assert settle.call_count == 1
    server.backend.call.assert_awaited_once()
    args["expected_amount_atomic"] = 9999
    with pytest.raises(PaymentError, match="different request"):
        await wallet.call_agent(**args)
    assert settle.call_count == 1


def test_connect_preserves_disabled_wallet_and_budget(config, tmp_path):
    config.wallet.payments_enabled = False
    path = tmp_path / "buyer.toml"
    path.write_text(tomli_w.dumps(config.model_dump(mode="json", exclude_none=True)))
    before = config.wallet.model_dump()
    token = tmp_path / "envar.token"
    token.write_text("envar_agent_" + "x" * 40)
    token.chmod(0o600)
    agent_id = str(uuid.uuid4())
    result = connect_config(path, agent_id, "challenge-" + "a" * 30, token_file=token)
    after = load_config(path)
    assert after.wallet.model_dump() == before
    assert after.registration.agent_id == after.connection.agent_id == agent_id
    assert not result["signing_policy_changed"]
    assert path.stat().st_mode & 0o777 == 0o600


def test_connect_rejects_symlink_and_wrong_credential(config, tmp_path):
    path = tmp_path / "buyer.toml"
    path.write_text(tomli_w.dumps(config.model_dump(mode="json", exclude_none=True)))
    original = path.read_text()
    alias = tmp_path / "alias.toml"
    alias.symlink_to(path)
    with pytest.raises(PaymentError):
        connect_config(alias, str(uuid.uuid4()), "a" * 30)
    assert path.read_text() == original
    token = tmp_path / "wrong.token"
    token.write_text("private_wallet_" + "a" * 32)
    token.chmod(0o600)
    with pytest.raises(PaymentError):
        connect_config(path, str(uuid.uuid4()), "a" * 30, token_file=token)
    assert path.read_text() == original


def test_approve_peer_preserves_existing_allowlist_and_limits(config, tmp_path):
    from envarpay.onboarding import approve_peer

    path = tmp_path / "buyer.toml"
    path.write_text(tomli_w.dumps(config.model_dump(mode="json", exclude_none=True)))
    original = config.wallet.model_dump()
    added = approve_peer(
        path,
        "another",
        "https://reviewed.example/mcp",
        "0x" + "44" * 20,
        "ask_agent",
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    current = load_config(path).wallet
    assert current.max_per_call_atomic == original["max_per_call_atomic"]
    assert current.max_total_atomic == original["max_total_atomic"]
    assert current.peers["seller"].model_dump() == original["peers"]["seller"]
    assert not current.peers["another"].recovery
    assert not added["budgets_changed"]
    before = path.read_text()
    with pytest.raises(PaymentError):
        approve_peer(
            path,
            "another",
            "https://changed.example/mcp",
            "0x" + "44" * 20,
            "ask_agent",
            str(uuid.uuid4()),
            str(uuid.uuid4()),
        )
    assert path.read_text() == before


def test_task_approval_leaves_signing_and_evaluator_disabled(tmp_path):
    from envarpay.onboarding import approve_peer
    from envarpay.tasks.config import TaskConfig, load_task_config

    cfg = TaskConfig(contract="0x" + "55" * 20, key_file="buyer.key")
    path = tmp_path / "task.toml"
    path.write_text(tomli_w.dumps(cfg.model_dump(mode="json", exclude_none=True)))
    token = tmp_path / "provider.token"
    token.write_text("buyer-approved-token-" + "x" * 40)
    token.chmod(0o600)
    approve_peer(
        path,
        "task-peer",
        "https://task.example",
        "0x" + "44" * 20,
        "ask_agent",
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        task=True,
        amount_atomic=10000,
        token_file=token,
    )
    current = load_task_config(path)
    assert not current.signing_enabled and not current.evaluator_enabled
    assert current.max_total_atomic == cfg.max_total_atomic
    assert current.peers["task-peer"].tools == {"ask_agent": 10000}
