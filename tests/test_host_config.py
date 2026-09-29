from pathlib import Path

import pytest

from envarpay.cli import initialize
from envarpay.host_config import host_config
from envarpay.storage import PaymentError


@pytest.mark.parametrize("host", ["hermes", "openclaw", "opencode"])
def test_snippets_only_preserve_configuration_and_use_isolated_python(tmp_path, host):
    initialize(tmp_path / "setup", "0x" + "33" * 20, "mcp")
    path = tmp_path / "setup/buyer.toml"
    before = path.read_bytes()
    value = host_config(host, path)
    if host == "hermes":
        item = value["mcp_servers"]["envarpay"]
        command = [item["command"], *item["args"]]
        assert item["timeout"] > 180
    elif host == "openclaw":
        item = value["mcp"]["servers"]["envarpay"]
        command = [item["command"], *item["args"]]
        assert len(item["toolFilter"]["include"]) == 3
        assert item["requestTimeoutMs"] > 180000
    else:
        item = value["mcp"]["envarpay"]
        command = item["command"]
        assert item["timeout"] > 180000
    assert Path(command[0]).is_absolute()
    assert command[1:] == ["-m", "envarpay", "wallet", "--config", str(path)]
    assert path.read_bytes() == before
    assert not (tmp_path / "setup/buyer.key").exists()


def test_seller_only_config_is_not_a_buyer(tmp_path):
    initialize(tmp_path / "setup", "0x" + "33" * 20, "mcp")
    with pytest.raises(PaymentError, match="wallet"):
        host_config("hermes", tmp_path / "setup/seller.toml")
