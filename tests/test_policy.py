import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import ValidationError
from x402.schemas import PaymentRequired
from x402.schemas.hooks import PaymentCreationContext

from envarpay.chain import Chain
from envarpay.config import Endpoint
from envarpay.storage import PaymentError, Store, secret_file
from envarpay.wallet import validate_quote


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("network", "eip155:8453"),
        ("asset", "0x" + "11" * 20),
        ("payTo", "0x" + "22" * 20),
        ("amount", "10001"),
        ("amount", "0"),
        ("maxTimeoutSeconds", 601),
        ("scheme", "other"),
        ("extra", {"name": "USDC", "version": "2", "paymentFlow": "authorization"}),
        (
            "extra",
            {
                "name": "USDC",
                "version": "2",
                "paymentFlow": "upfront",
                "assetTransferMethod": "permit2",
            },
        ),
    ],
)
async def test_rejects_changed_terms_before_signing(config, quote, field, value):
    quote["accepts"][0][field] = value
    required = PaymentRequired.model_validate(quote)
    with pytest.raises(PaymentError):
        validate_quote(
            config,
            config.wallet.peers["seller"],
            "ask_agent",
            PaymentCreationContext(required, required.accepts[0]),
        )


async def test_disabled_and_resource_mismatch(config, quote):
    required = PaymentRequired.model_validate(quote)
    config.wallet.payments_enabled = False
    with pytest.raises(PaymentError, match="disabled"):
        validate_quote(
            config,
            config.wallet.peers["seller"],
            "ask_agent",
            PaymentCreationContext(required, required.accepts[0]),
        )
    config.wallet.payments_enabled = True
    with pytest.raises(PaymentError, match="resource"):
        validate_quote(
            config,
            config.wallet.peers["seller"],
            "different_tool",
            PaymentCreationContext(required, required.accepts[0]),
        )


def test_atomic_budget_survives_process_recreation(tmp_path):
    directory = str(tmp_path / "state")
    Store(directory)

    def reserve(n: int) -> bool:
        store = Store(directory)
        store.claim(f"buy:{n}", f"binding-{n}", {})
        try:
            store.reserve_budget(f"buy:{n}", 10000, 10000)
            return True
        except PaymentError:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(8))) == 1
    used = sum(row["amount"] for row in Store(directory).public_status())
    assert used == 10000


def test_secrets_and_status_redaction(tmp_path):
    key = tmp_path / "secret"
    key.write_text("do-not-display")
    key.chmod(0o644)
    with pytest.raises(PaymentError):
        secret_file(key)
    key.chmod(0o600)
    assert secret_file(key) == "do-not-display"
    store = Store(str(tmp_path / "state"))
    store.claim("buy:1", "binding", {"payload": "signature-secret"})
    assert "signature-secret" not in json.dumps(store.public_status())


def test_remote_http_requires_operator_choice():
    with pytest.raises(ValidationError):
        Endpoint(url="http://example.org/mcp")
    assert Endpoint(url="http://agent-a:4020/mcp", allow_http=True)
    with pytest.raises(ValidationError):
        Endpoint(url="https://user:password@example.org/mcp")


@pytest.fixture
def historical_receipt():
    evidence = json.loads(
        (Path(__file__).parent / "fixtures/real-sepolia-receipt.json").read_text()
    )
    return evidence["receipt"], evidence["transaction"], evidence["authorization"]


def test_usdc_domain_names_match_official_network_profiles(config):
    assert config.token_name == "USDC"
    config.network = "eip155:8453"
    assert config.token_name == "USD Coin"
    assert config.asset == "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def test_real_historical_receipt_decodes(config, historical_receipt):
    Chain(config).validate_receipt(*historical_receipt)


@pytest.mark.parametrize(
    "tamper", ["amount", "payer", "payee", "nonce", "asset", "status", "duplicate", "removed"]
)
def test_receipt_rejects_wrong_transfer(config, historical_receipt, tamper):
    receipt, tx, auth = copy.deepcopy(historical_receipt)
    if tamper in ("payer", "payee", "nonce", "amount"):
        field = {"payer": "from", "payee": "to", "nonce": "nonce", "amount": "value"}[tamper]
        auth[field] = "1" if tamper == "amount" else "0x" + "55" * (32 if tamper == "nonce" else 20)
    elif tamper == "asset":
        receipt["logs"][1]["address"] = "0x" + "44" * 20
    elif tamper == "status":
        receipt["status"] = "0x0"
    elif tamper == "duplicate":
        receipt["logs"].append(receipt["logs"][1])
    else:
        receipt["logs"][1]["removed"] = True
    with pytest.raises(PaymentError):
        Chain(config).validate_receipt(receipt, tx, auth)
