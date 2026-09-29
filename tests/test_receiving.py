import uuid
from unittest.mock import AsyncMock

import pytest
import tomli_w

from envarpay.config import Connection, Receiving, load_config
from envarpay.receiving import apply_receiving
from envarpay.seller import PaidServer
from envarpay.storage import PaymentError, digest


def setup(server, tmp_path):
    token = tmp_path / "envar.token"
    token.write_text("envar_agent_" + "x" * 40)
    token.chmod(0o600)
    server.config.connection = Connection(
        agent_id=str(uuid.uuid4()), token_file=str(token), accept_receiving_updates=True
    )
    from envarpay.directory import Envar

    server.envar = Envar(server.config.connection, server.store)
    path = tmp_path / "seller.toml"
    path.write_text(tomli_w.dumps(server.config.model_dump(mode="json", exclude_none=True)))
    desired = Receiving(
        network=server.config.network,
        pay_to=server.policy.pay_to,
        tools={"ask_agent": {"amount_atomic": 123}},
    )
    response = {
        "revision": 2,
        "config": desired.model_dump(mode="json"),
        "digest": digest(desired.model_dump(mode="json")),
    }
    return path, response


async def test_explicitly_enabled_settings_apply_and_ack_retry_without_replacing_runtime(
    paid_server, tmp_path, monkeypatch
):
    server, _, _ = paid_server
    path, response = setup(server, tmp_path)
    original_backend = server.config.seller.backend.model_dump()
    server.envar.request = AsyncMock(
        side_effect=[response, TimeoutError(), response, {"accepted": True}]
    )
    initialized = AsyncMock()
    monkeypatch.setattr(PaidServer, "initialize", initialized)
    with pytest.raises(TimeoutError):
        await apply_receiving(server, path)
    config = load_config(path)
    assert config.seller.tools["ask_agent"].amount_atomic == 123
    assert config.seller.backend.model_dump() == original_backend
    assert config.wallet is None
    first = server.current
    assert await apply_receiving(server, path)
    assert server.current is first
    assert initialized.await_count == 1


async def test_receiving_rejects_network_change_and_remote_wallet_fields(paid_server, tmp_path):
    server, _, _ = paid_server
    path, response = setup(server, tmp_path)
    original = path.read_text()
    response["config"]["network"] = "eip155:8453"
    response["digest"] = digest(response["config"])
    server.envar.request = AsyncMock(return_value=response)
    with pytest.raises(PaymentError, match="same network"):
        await apply_receiving(server, path)
    assert path.read_text() == original and server.current is None
    response["config"]["network"] = server.config.network
    response["config"]["wallet"] = {"payments_enabled": True}
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        await apply_receiving(server, path)
    assert path.read_text() == original


async def test_local_opt_out_prevents_platform_configuration_mutation(paid_server, tmp_path):
    server, _, _ = paid_server
    path, response = setup(server, tmp_path)
    local = load_config(path)
    local.connection.accept_receiving_updates = False
    path.write_text(tomli_w.dumps(local.model_dump(mode="json", exclude_none=True)))
    original = path.read_text()
    server.envar.request = AsyncMock(return_value=response)
    assert not await apply_receiving(server, path)
    assert path.read_text() == original and server.current is None
