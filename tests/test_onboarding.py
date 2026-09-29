import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from envarpay.config import load_config
from envarpay.setup import AGENTS, atomic_usdc, describe_config, initialize
from envarpay.storage import PaymentError

SELLER = "0x" + "33" * 20
PEER = "0x" + "44" * 20


@pytest.mark.parametrize("agent", AGENTS)
def test_buyer_setup_is_disabled_and_has_native_launch_parameters(tmp_path, agent):
    folder = tmp_path / "a path with spaces"
    result = initialize(
        folder,
        PEER,
        agent=agent,
        role="buyer",
        peer_url="https://seller.example/mcp",
        max_per_call="0.000001",
        budget="0.000003",
    )
    config = load_config(folder / "buyer.toml")
    assert config.wallet.max_per_call_atomic == 1
    assert config.wallet.max_total_atomic == 3
    assert config.wallet.peers["seller"].pay_to == PEER
    assert not config.wallet.payments_enabled
    assert not (folder / "seller.toml").exists()
    assert not (folder / "buyer.key").exists()
    assert not (folder / "buyer-state").exists()
    command = json.loads((folder / "wallet-command.json").read_text())
    assert command == {
        "command": sys.executable,
        "args": ["-m", "envarpay", "wallet", "--config", str(folder / "buyer.toml")],
    }
    assert (folder / "host-config.json").exists() == (agent in AGENTS[:4])
    assert result["buyer"]["budget_usdc"] == "0.000003"
    assert "payments_enabled = true only after" in (folder / "SETUP.md").read_text()
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in folder.iterdir())


def test_both_roles_keep_own_recipient_separate_from_peer(tmp_path):
    initialize(
        tmp_path / "setup",
        SELLER,
        role="both",
        agent="hermes",
        peer_url="https://peer.example/mcp",
        peer_pay_to=PEER,
        price="0.002500",
        max_per_call="0.004",
        budget="0.008",
    )
    buyer = load_config(tmp_path / "setup/buyer.toml")
    seller = load_config(tmp_path / "setup/seller.toml")
    assert buyer.wallet.peers["seller"].pay_to == PEER
    assert seller.seller.pay_to == SELLER
    assert seller.seller.tools["ask_agent"].amount_atomic == 2500
    assert buyer.wallet.max_per_call_atomic == 4000
    assert buyer.wallet.max_total_atomic == 8000
    assert buyer.state_dir != seller.state_dir


def test_seller_setup_preserves_dotted_tool_name_as_one_priced_tool(tmp_path):
    initialize(
        tmp_path / "setup",
        SELLER,
        role="seller",
        tool="agent.summarize",
        upstream="https://private.example/mcp",
        price="0.005",
    )
    seller = load_config(tmp_path / "setup/seller.toml").seller
    assert list(seller.tools) == ["agent.summarize"]
    assert seller.tools["agent.summarize"].amount_atomic == 5000
    assert seller.backend.upstream.url == "https://private.example/mcp"
    assert not (tmp_path / "setup/buyer.toml").exists()
    assert not (tmp_path / "setup/host-config.json").exists()


@pytest.mark.parametrize("amount", ["0", "-1", "NaN", "1e-6", "0.0000001", "1000001", "1,000"])
def test_amounts_never_round_or_accept_ambiguous_units(amount):
    with pytest.raises(PaymentError):
        atomic_usdc(amount)


@pytest.mark.parametrize(
    "options",
    [
        {"budget": "0.001", "max_per_call": "0.002"},
        {"peer_url": "https://another.example/mcp"},
        {"role": "buyer", "peer_pay_to": PEER},
        {"backend": "hermes-http", "upstream": "https://another.example/mcp"},
        {"role": "seller", "upstream": "https://user:secret@example.com/mcp"},
        {"role": "seller", "upstream": "http://remote.example/mcp"},
    ],
)
def test_invalid_setup_leaves_no_partial_files(tmp_path, options):
    with pytest.raises((PaymentError, ValidationError)):
        initialize(tmp_path / "setup", SELLER, **options)
    assert not (tmp_path / "setup").exists()


def test_private_container_http_needs_an_explicit_option(tmp_path):
    initialize(
        tmp_path / "setup",
        SELLER,
        role="seller",
        upstream="http://runtime-hermes:8000/mcp",
        allow_http=True,
    )
    config = load_config(tmp_path / "setup/seller.toml")
    assert config.seller.backend.upstream.allow_http


def test_cli_summary_and_doctor_show_exact_policy_without_creating_state(tmp_path: Path):
    folder = tmp_path / "setup"
    command = [sys.executable, "-m", "envarpay"]
    output = subprocess.check_output(
        command
        + [
            "init",
            "--directory",
            str(folder),
            "--agent",
            "openclaw",
            "--role",
            "buyer",
            "--pay-to",
            PEER,
            "--peer-url",
            "https://seller.example/mcp",
            "--budget",
            "0.02",
        ],
        text=True,
    )
    assert "Buyer payments: OFF" in output and "host-config.json" in output
    assert "0.02" in output and PEER in output
    info = json.loads(
        subprocess.check_output(
            command + ["doctor", "--config", str(folder / "buyer.toml")], text=True
        )
    )
    assert info["chain_id"] == 84532 and not info["rpc_checked"]
    assert info["buyer"]["budget_usdc"] == "0.02"
    assert not info["buyer"]["key_file_present"]
    assert not (folder / "buyer-state").exists()
    assert not (folder / "buyer.key").exists()
    info = describe_config(load_config(folder / "buyer.toml"))
    assert "key_file" not in info["buyer"]


def test_example_seller_refuses_to_start_without_model_configuration(monkeypatch):
    for name in ("MODEL_NAME", "MODEL_BASE_URL", "MODEL_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    result = subprocess.run(
        [sys.executable, "examples/integrations/python_agents.py", "pydantic-ai", "seller"],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 2
    assert "Configure MODEL_NAME, MODEL_BASE_URL and MODEL_API_KEY before starting" in result.stderr


def test_private_mode_preserves_existing_service_setup_and_hides_token(tmp_path):
    folder = tmp_path / "private"
    output = subprocess.check_output(
        [
            sys.executable,
            "-m",
            "envarpay",
            "init",
            "--mode",
            "private",
            "--agent",
            "hermes",
            "--backend",
            "hermes-http",
            "--directory",
            str(folder),
            "--json",
        ],
        text=True,
    )
    info = json.loads(output)
    config = load_config(folder / "agent.toml")
    assert config.service and not config.seller and not config.wallet
    assert config.service.backend.kind == "http"
    assert info["role"] == "private" and info["payments_enabled"] is False
    token = (folder / "service.token").read_text().strip()
    assert token not in output and token not in (folder / "SETUP.md").read_text()
    assert "service.token" in (folder / ".gitignore").read_text()
    assert (folder / "service.token").stat().st_mode & 0o777 == 0o600
    assert not (folder / "buyer.key").exists()


def test_status_and_reconcile_do_not_require_running_sync_first(tmp_path):
    folder = tmp_path / "buyer"
    initialize(folder, PEER, role="buyer")
    command = [sys.executable, "-m", "envarpay"]
    output = subprocess.check_output(
        command + ["status", "--config", str(folder / "buyer.toml")], text=True
    )
    assert json.loads(output) == []
    result = subprocess.run(
        command
        + [
            "reconcile",
            "--config",
            str(folder / "buyer.toml"),
            "--operation-id",
            "buy:never-attempted",
        ],
        text=True,
        capture_output=True,
    )
    assert result.returncode == 1 and "No recorded transaction" in result.stderr
    assert not (folder / "buyer.key").exists()
