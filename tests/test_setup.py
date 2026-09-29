import json
import subprocess
import sys
from pathlib import Path

import pytest

from envar_pay.backend import AgentBackend
from envar_pay.cli import initialize
from envar_pay.config import Backend, load_config
from envar_pay.storage import PaymentError


def test_init_does_not_overwrite_and_resolves_paths_from_config(tmp_path: Path):
    folder = tmp_path / "setup"
    initialize(folder, "0x" + "33" * 20, "mcp")
    config = load_config(folder / "buyer.toml")
    assert config.wallet.key_file == str(folder / "buyer.key")
    assert config.state_dir == str(folder / "buyer-state")
    assert config.wallet.payments_enabled is False
    assert "*-state/" in (folder / ".gitignore").read_text()
    with pytest.raises(PaymentError, match="empty directory"):
        initialize(folder, "0x" + "44" * 20, "hermes")
    assert load_config(folder / "seller.toml").seller.pay_to.lower() == "0x" + "33" * 20


def test_cli_key_generation_and_hermes_snippet(tmp_path: Path):
    key = tmp_path / "buyer.key"
    result = subprocess.run(
        [sys.executable, "-m", "envar_pay", "keygen", "--output", str(key)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0 and len(json.loads(result.stdout)["address"]) == 42
    assert key.stat().st_mode & 0o777 == 0o600
    assert key.read_text().strip() not in result.stdout + result.stderr
    duplicate = subprocess.run(
        [sys.executable, "-m", "envar_pay", "keygen", "--output", str(key)],
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
            "envar_pay",
            "hermes-config",
            "--config",
            str(folder / "buyer.toml"),
        ],
        text=True,
    )
    item = json.loads(output)["mcp_servers"]["payments"]
    assert Path(item["command"]).is_absolute() and Path(item["args"][-1]).is_absolute()
    assert item["args"][:3] == ["-m", "envar_pay", "wallet"]


@pytest.mark.parametrize(
    "model,base_url,env",
    [
        ("YOUR_MODEL", None, None),
        ("configured", "https://YOUR_MODEL_ENDPOINT/v1", None),
        ("configured", None, "ENVAR_TEST_MISSING_MODEL_KEY"),
    ],
)
def test_incomplete_hermes_setup_fails_before_quoting(model, base_url, env, monkeypatch):
    if env:
        monkeypatch.delenv(env, raising=False)
    backend = AgentBackend(
        Backend(kind="hermes", model=model, base_url=base_url, api_key_env=env), 30
    )
    with pytest.raises(PaymentError):
        backend.check_configuration()
