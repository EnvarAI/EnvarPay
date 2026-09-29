import json
import subprocess
import sys
from pathlib import Path

import pytest

from envarpay.cli import initialize
from envarpay.config import Backend, load_config
from envarpay.storage import PaymentError


def test_init_does_not_overwrite_and_resolves_paths_from_config(tmp_path: Path):
    folder = tmp_path / "setup"
    initialize(folder, "0x" + "33" * 20, "mcp")
    config = load_config(folder / "buyer.toml")
    assert config.wallet.key_file == str(folder / "buyer.key")
    assert config.state_dir == str(folder / "buyer-state")
    assert config.wallet.payments_enabled is False
    assert "*-state/" in (folder / ".gitignore").read_text()
    with pytest.raises(PaymentError, match="empty directory"):
        initialize(folder, "0x" + "44" * 20, "mcp")
    assert load_config(folder / "seller.toml").seller.pay_to.lower() == "0x" + "33" * 20


def test_cli_key_generation_and_hermes_snippet(tmp_path: Path):
    key = tmp_path / "buyer.key"
    result = subprocess.run(
        [sys.executable, "-m", "envarpay", "keygen", "--output", str(key)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0 and len(json.loads(result.stdout)["address"]) == 42
    assert key.stat().st_mode & 0o777 == 0o600
    assert key.read_text().strip() not in result.stdout + result.stderr
    duplicate = subprocess.run(
        [sys.executable, "-m", "envarpay", "keygen", "--output", str(key)],
        capture_output=True,
        text=True,
    )
    assert duplicate.returncode == 1
    folder = tmp_path / "setup"
    initialize(folder, "0x" + "33" * 20, "mcp")
    output = subprocess.check_output(
        [
            sys.executable,
            "-m",
            "envarpay",
            "host-config",
            "--host",
            "hermes",
            "--config",
            str(folder / "buyer.toml"),
        ],
        text=True,
    )
    item = json.loads(output)["mcp_servers"]["envarpay"]
    assert Path(item["command"]).is_absolute() and Path(item["args"][-1]).is_absolute()
    assert item["args"][:3] == ["-m", "envarpay", "wallet"]


def test_embedded_hermes_backend_has_been_removed():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Backend(kind="hermes", model="model")


def test_private_service_setup_needs_no_wallet(tmp_path):
    from envarpay.service import AgentService

    result = initialize(tmp_path / "agent", None, "hermes-http", "private")
    loaded = load_config(Path(result["config"]))
    assert loaded.seller is None and loaded.wallet is None
    assert loaded.service.backend.kind == "http"
    token = Path(result["token_file"]).read_text().strip()
    assert len(token) >= 32 and token not in str(result)
    assert Path(result["token_file"]).stat().st_mode & 0o777 == 0o600
    assert AgentService(loaded).policy.port == 4020
