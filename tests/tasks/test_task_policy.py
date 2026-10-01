import concurrent.futures
import json

import pytest
from pydantic import ValidationError

from envarpay.storage import PaymentError
from envarpay.tasks.config import TaskConfig
from envarpay.tasks.models import TaskSpec
from envarpay.tasks.store import TaskStore

A, B, C, T = ["0x" + x * 40 for x in "1234"]


def spec(**kw):
    return TaskSpec(
        request_id=kw.pop("request_id", "task-1"),
        chain_id=84532,
        contract=C,
        token=T,
        client=A,
        provider=B,
        evaluator=A,
        amount_atomic=10000,
        deadline=2000000000,
        tool="ask",
        arguments=kw.pop("arguments", {"q": "hello"}),
        acceptance="JSON matches agreed schema",
        **kw,
    )


def test_terms_bind_input_and_identity():
    a, b = spec(), spec(arguments={"q": "changed"})
    assert a.job_id == b.job_id and a.terms_hash != b.terms_hash
    assert spec(request_id="task-2").job_id != a.job_id
    with pytest.raises(ValidationError):
        spec(arguments={"q": float("nan")})
    with pytest.raises(ValidationError):
        spec(arguments={"q": "x" * 70000})


def test_budget_atomic_concurrency_and_refund(tmp_path):
    store = TaskStore(str(tmp_path / "state"))

    def reserve(i):
        try:
            return store.add(spec(request_id=f"task-{i}"), "buyer", {}, maximum=30000)
        except PaymentError:
            return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(reserve, range(12)))
    assert sum(results) == 3
    row = store.list_tasks("reserved")[0]
    store.release_refunded(row["id"])
    assert store.add(spec(request_id="after-refund"), "buyer", {}, maximum=30000)
    with pytest.raises(PaymentError):
        store.add(spec(request_id="too-much"), "buyer", {}, maximum=30000)


def test_duplicate_and_decision_frozen(tmp_path):
    store = TaskStore(str(tmp_path / "state"))
    a = spec()
    assert store.add(a, "seller", {}, capacity=1)
    assert not store.add(a, "seller", {}, capacity=1)
    with pytest.raises(PaymentError):
        store.add(spec(arguments={"different": True}), "seller", {}, capacity=1)
    assert store.transition(a.job_id.hex(), "running", expected={"queued"})
    assert not store.transition(a.job_id.hex(), "running", expected={"queued"})
    store.freeze_decision(a.job_id.hex(), {"action": "accept", "reason": "ok"})
    with pytest.raises(PaymentError):
        store.freeze_decision(a.job_id.hex(), {"action": "reject", "reason": "no"})


def test_task_defaults_fail_closed():
    cfg = TaskConfig(contract=C, key_file="key")
    assert not cfg.signing_enabled and cfg.chain_id == 84532
    with pytest.raises(ValidationError):
        TaskConfig(contract=C, key_file="key", network="mainnet")
    with pytest.raises(ValidationError):
        TaskConfig(contract=C, key_file="key", token=T)
    with pytest.raises(ValidationError):
        TaskConfig(contract=C, key_file="key", network="local", rpc_url="https://example.com")
    with pytest.raises(ValidationError):
        TaskConfig(contract=C, key_file="key", workers=2)


def test_wheel_includes_pinned_contract():
    from envarpay.tasks.chain import artifact

    a = artifact()
    assert (
        a["compiler"].startswith("0.8.30") and a["evm"]["deployedBytecode"]["immutableReferences"]
    )
    assert len(a["evm"]["bytecode"]["object"]) > 1000
    json.dumps(a)
