import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from web3.exceptions import BlockNotFound

from envarpay.storage import PaymentError

spec = importlib.util.spec_from_file_location(
    "task_deploy_example", Path("examples/tasks/deploy.py")
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def test_receipt_before_public_rpc_block(monkeypatch):
    receipt = SimpleNamespace(status=1, blockNumber=100, blockHash=b"canonical")
    calls = []

    def get_block(number):
        calls.append(number)
        if len(calls) == 1:
            raise BlockNotFound("replica not caught up")
        return SimpleNamespace(hash=b"canonical")

    eth = SimpleNamespace(
        wait_for_transaction_receipt=lambda *a, **kw: receipt, get_block=get_block, block_number=101
    )
    monkeypatch.setattr(deploy.time, "sleep", lambda _: None)
    assert deploy.wait_canonical_deployment(SimpleNamespace(eth=eth), "original") is receipt
    assert calls == [100, 100]


def test_deployment_wrong_canonical_block():
    receipt = SimpleNamespace(status=1, blockNumber=100, blockHash=b"old")
    eth = SimpleNamespace(
        wait_for_transaction_receipt=lambda *a, **kw: receipt,
        get_block=lambda _: SimpleNamespace(hash=b"different"),
        block_number=101,
    )
    with pytest.raises(PaymentError, match="not canonical"):
        deploy.wait_canonical_deployment(SimpleNamespace(eth=eth), "original")
