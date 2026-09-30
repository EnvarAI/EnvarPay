"""Actual EVM + HTTP task flow. Run against isolated Ganache, never a public RPC."""

import asyncio
import json
import os
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from eth_account import Account
from mcp.types import CallToolResult, TextContent, Tool
from web3 import Web3

from envarpay.config import Backend, Endpoint
from envarpay.storage import PaymentError
from envarpay.tasks.chain import artifact
from envarpay.tasks.client import TaskWallet
from envarpay.tasks.config import TaskClient, TaskConfig, TaskPeer
from envarpay.tasks.models import TaskSpec, commitment
from envarpay.tasks.server import TaskServer

RPC = os.environ.get("ENVARPAY_TASK_TEST_RPC")
pytestmark = pytest.mark.skipif(not RPC, reason="explicit isolated local EVM required")


class BackendStub:
    def __init__(self):
        self.calls = 0
        self.delay = 0.1
        self.error = False

    async def list_tools(self):
        return [
            Tool(
                name="ask",
                inputSchema={
                    "type": "object",
                    "properties": {"question": {"type": "string"}},
                    "required": ["question"],
                    "additionalProperties": False,
                },
            )
        ]

    async def call(self, name, arguments):
        self.calls += 1
        await asyncio.sleep(self.delay)
        return CallToolResult(
            content=[TextContent(type="text", text="verified result: " + arguments["question"])],
            isError=self.error,
        )


@pytest.fixture
def env(tmp_path):
    assert RPC.startswith("http://127.0.0.1:")
    w = Web3(Web3.HTTPProvider(RPC))
    assert w.eth.chain_id == 31337

    def tx(fn):
        h = fn.transact({"from": w.eth.accounts[0]})
        r = w.eth.wait_for_transaction_receipt(h)
        assert r.status == 1
        return r

    a = json.loads(Path("contracts/task/MockUSDC.json").read_text())
    token = w.eth.contract(abi=a["abi"], bytecode=a["evm"]["bytecode"]["object"])
    token = w.eth.contract(address=tx(token.constructor()).contractAddress, abi=a["abi"])
    a = artifact()
    escrow = w.eth.contract(abi=a["abi"], bytecode=a["evm"]["bytecode"]["object"])
    escrow = w.eth.contract(
        address=tx(escrow.constructor(token.address)).contractAddress, abi=a["abi"]
    )
    accounts = {role: Account.create() for role in ["buyer", "seller", "other"]}
    for role, acc in accounts.items():
        p = tmp_path / (role + ".key")
        p.write_text(acc.key.hex())
        p.chmod(0o600)
        w.eth.wait_for_transaction_receipt(
            w.eth.send_transaction({"from": w.eth.accounts[0], "to": acc.address, "value": 10**18})
        )
    tx(token.functions.transfer(accounts["buyer"].address, 1000000))
    for role in ["buyer", "other"]:
        p = tmp_path / (role + ".token")
        p.write_text(role * 40)
        p.chmod(0o600)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    common = {
        "network": "local",
        "rpc_url": RPC,
        "contract": escrow.address,
        "token": token.address,
        "signing_enabled": True,
        "evaluator_enabled": True,
        "confirmations": 1,
        "timeout_seconds": 10,
    }
    seller = TaskConfig(
        **common,
        key_file=str(tmp_path / "seller.key"),
        state_dir=str(tmp_path / "seller-state"),
        tools={"ask": 10000},
        clients={
            role: TaskClient(
                address=accounts[role].address, token_file=str(tmp_path / (role + ".token"))
            )
            for role in ["buyer", "other"]
        },
        backend=Backend(kind="mcp", upstream=Endpoint(url="http://127.0.0.1:1/mcp")),
    )
    buyer = TaskConfig(
        **common,
        key_file=str(tmp_path / "buyer.key"),
        state_dir=str(tmp_path / "buyer-state"),
        max_total_atomic=30000,
        peers={
            "seller": TaskPeer(
                url=f"http://127.0.0.1:{port}",
                provider=accounts["seller"].address,
                token_file=str(tmp_path / "buyer.token"),
                tools={"ask": 10000},
            )
        },
    )
    server = TaskServer(seller)
    backend = BackendStub()
    server.backend = backend
    http = uvicorn.Server(
        uvicorn.Config(server.app(), host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=http.run, daemon=True)
    thread.start()
    for _ in range(100):
        if http.started:
            break
        time.sleep(0.05)
    assert http.started
    yield {
        "wallet": TaskWallet(buyer),
        "server": server,
        "backend": backend,
        "http": http,
        "thread": thread,
        "w": w,
        "token": token,
        "escrow": escrow,
        "accounts": accounts,
        "buyer_cfg": buyer,
        "port": port,
    }
    http.should_exit = True
    thread.join(5)


def wait_result(wallet, rid):
    for _ in range(150):
        result = wallet.result(rid)
        if result["status"] in ("submitted", "failed", "unknown"):
            return result
        time.sleep(0.1)
    raise AssertionError("Task did not finish")


def test_actual_http_escrow_delivery_accept_replay(env):
    wallet = env["wallet"]
    provider = env["accounts"]["seller"].address
    assert env["token"].functions.balanceOf(provider).call() == 0
    created = wallet.purchase("seller", "ask", {"question": "one"}, "must contain one", "job-1")
    result = wait_result(wallet, "job-1")
    assert result["status"] == "submitted"
    assert env["token"].functions.balanceOf(provider).call() == 0
    assert (
        wallet.purchase("seller", "ask", {"question": "one"}, "must contain one", "job-1")["job_id"]
        == created["job_id"]
    )
    with pytest.raises(PaymentError):
        wallet.purchase("seller", "ask", {"question": "changed"}, "must contain one", "job-1")
    done = wallet.decide("job-1", "accept", "correct")
    assert done["payment"]["status"] == "Completed"
    assert env["token"].functions.balanceOf(provider).call() == 10000
    assert wallet.decide("job-1", "accept", "correct")["payment"]["status"] == "Completed"
    assert env["backend"].calls == 1
    assert env["token"].functions.balanceOf(provider).call() == 10000
    with pytest.raises(PaymentError):
        wallet.decide("job-1", "reject", "changed decision")
    other = "Bearer " + ("other" * 40)
    with httpx.Client() as c:
        url = f"http://127.0.0.1:{env['port']}/tasks/" + created["job_id"]
        assert c.get(url).status_code == 401
        assert c.get(url, headers={"Authorization": other}).status_code == 404


def test_reject_full_refund_and_budget(env):
    wallet = env["wallet"]
    buyer = wallet.chain.address
    before = env["token"].functions.balanceOf(buyer).call()
    wallet.purchase("seller", "ask", {"question": "bad"}, "must contain good", "reject-1")
    wait_result(wallet, "reject-1")
    done = wallet.decide("reject-1", "reject", "did not meet acceptance")
    assert done["payment"]["status"] == "Rejected"
    assert env["token"].functions.balanceOf(buyer).call() == before
    row, _ = wallet.original("reject-1")
    assert row["reserved"] == 0
    assert env["token"].functions.balanceOf(env["accounts"]["seller"].address).call() == 0


def test_result_hash_tamper_refuses_accept(env):
    wallet = env["wallet"]
    wallet.purchase("seller", "ask", {"question": "hash"}, "exact", "hash-1")
    wait_result(wallet, "hash-1")
    row, spec = wallet.original("hash-1")
    wallet.store.transition(row["id"], None, result={"tampered": True})
    with pytest.raises(PaymentError):
        wallet.decide("hash-1", "accept", "ok")
    assert wallet.chain.job(spec)["status"] == "Submitted"


def test_expiry_refund_and_wrong_signer(env):
    wallet = env["wallet"]
    cfg = wallet.config
    w = env["w"]
    now = w.eth.get_block("latest").timestamp
    spec = TaskSpec(
        request_id="expiry",
        chain_id=31337,
        contract=cfg.contract,
        token=cfg.token,
        client=wallet.chain.address,
        provider=env["accounts"]["seller"].address,
        evaluator=wallet.chain.address,
        amount_atomic=10000,
        deadline=now + 20,
        tool="ask",
        arguments={"question": "expire"},
        acceptance="no work",
    )
    wallet.store.add(
        spec,
        "buyer",
        {"peer": "seller", "peer_snapshot": cfg.peers["seller"].model_dump(), "duration": 20},
        maximum=cfg.max_total_atomic,
    )
    wallet.chain.fund(spec)
    with pytest.raises(PaymentError):
        env["server"].chain.verdict(spec, "complete", commitment("fake"))
    w.provider.make_request("evm_increaseTime", [30])
    w.provider.make_request("evm_mine", [])
    proof = wallet.decide("expiry", "refund", "expired")
    assert proof["payment"]["status"] == "Expired"
    assert wallet.store.get_task(spec.job_id.hex())["reserved"] == 0


def test_original_signed_tx_after_lost_receipt(env, monkeypatch):
    wallet = env["wallet"]
    original = wallet.chain.receipt
    calls = []

    def lose_once(tx):
        calls.append(tx)
        if len(calls) == 1:
            raise PaymentError("injected lost receipt")
        return original(tx)

    monkeypatch.setattr(wallet.chain, "receipt", lose_once)
    with pytest.raises(PaymentError):
        wallet.purchase("seller", "ask", {"question": "recover"}, "exact", "lost")
    monkeypatch.setattr(wallet.chain, "receipt", original)
    # Recover must reuse the original create transaction before approval/funding.
    wallet.recover("lost")
    assert wait_result(wallet, "lost")["status"] == "submitted"
    wallet.decide("lost", "accept", "verified")
    with wallet.store.connect() as db:
        rows = db.execute("SELECT id,tx_hash FROM task_transactions").fetchall()
    assert len(rows) == 4 and len({r["tx_hash"] for r in rows}) == 4
    assert env["backend"].calls == 1


def test_lost_completion_receipt_recovers_without_second_payout(env, monkeypatch):
    wallet = env["wallet"]
    wallet.purchase("seller", "ask", {"question": "completion"}, "exact", "completion")
    wait_result(wallet, "completion")
    original = wallet.chain.receipt

    def lost(tx):
        original(tx)
        raise PaymentError("injected lost completion response")

    monkeypatch.setattr(wallet.chain, "receipt", lost)
    with pytest.raises(PaymentError):
        wallet.decide("completion", "accept", "valid")
    monkeypatch.setattr(wallet.chain, "receipt", original)
    assert wallet.recover("completion")["payment"]["status"] == "Completed"
    assert env["token"].functions.balanceOf(env["accounts"]["seller"].address).call() == 10000


def test_server_restart_preserves_result_and_running_unknown(env):
    wallet = env["wallet"]
    wallet.purchase("seller", "ask", {"question": "restart"}, "exact", "restart")
    before = wait_result(wallet, "restart")
    env["http"].should_exit = True
    env["thread"].join(5)
    server = TaskServer(env["server"].config)
    server.backend = env["backend"]
    row, spec = wallet.original("restart")
    # A synthetic crashed running row must not be rerun on startup.
    synthetic = spec.model_copy(update={"request_id": "crash-injected"})
    server.store.add(synthetic, "seller", {})
    server.store.transition(synthetic.job_id.hex(), "running", expected={"queued"})
    http = uvicorn.Server(
        uvicorn.Config(server.app(), host="127.0.0.1", port=env["port"], log_level="error")
    )
    thread = threading.Thread(target=http.run, daemon=True)
    thread.start()
    env.update(http=http, thread=thread)
    for _ in range(100):
        if http.started:
            break
        time.sleep(0.05)
    assert http.started
    assert wallet.result("restart") == before
    assert server.store.get_task(synthetic.job_id.hex())["status"] == "unknown"
    assert env["backend"].calls == 1
    wallet.decide("restart", "accept", "verified")


def test_unfunded_request_cannot_execute(env):
    wallet = env["wallet"]
    cfg = wallet.config
    spec = TaskSpec(
        request_id="unfunded",
        chain_id=31337,
        contract=cfg.contract,
        token=cfg.token,
        client=wallet.chain.address,
        provider=env["accounts"]["seller"].address,
        evaluator=wallet.chain.address,
        amount_atomic=10000,
        deadline=env["w"].eth.get_block("latest").timestamp + 3600,
        tool="ask",
        arguments={"question": "free"},
        acceptance="exact",
    )
    with pytest.raises(httpx.HTTPStatusError):
        wallet.request("seller", "POST", "/tasks", spec.model_dump())
    assert env["backend"].calls == 0


def test_pending_queue_rechecks_expiry_before_execution(env):
    wallet = env["wallet"]
    cfg = wallet.config
    spec = TaskSpec(
        request_id="queued-expiry",
        chain_id=31337,
        contract=cfg.contract,
        token=cfg.token,
        client=wallet.chain.address,
        provider=env["accounts"]["seller"].address,
        evaluator=wallet.chain.address,
        amount_atomic=10000,
        deadline=env["w"].eth.get_block("latest").timestamp + 20,
        tool="ask",
        arguments={"question": "expired"},
        acceptance="exact",
    )
    wallet.chain.fund(spec)
    env["w"].provider.make_request("evm_increaseTime", [30])
    env["w"].provider.make_request("evm_mine", [])
    env["server"].store.add(spec, "seller", {})
    row = env["server"].store.get_task(spec.job_id.hex())
    asyncio.run(env["server"].execute(row))
    assert env["backend"].calls == 0


def test_receipt_transfer_and_bytecode_tampering(env, monkeypatch):
    wallet = env["wallet"]
    wallet.purchase("seller", "ask", {"question": "proof"}, "exact", "proof")
    row, spec = wallet.original("proof")
    receipt = wallet.chain.receipt(row["data"]["funding_proof"]["transaction"])
    with pytest.raises(PaymentError):
        wallet.chain.transfer(receipt, spec.client, spec.provider, spec.amount_atomic)
    with pytest.raises(PaymentError):
        wallet.chain.transfer(receipt, spec.client, spec.contract, spec.amount_atomic + 1)
    monkeypatch.setattr(wallet.chain.web3.eth, "get_code", lambda _: bytes(100))
    with pytest.raises(PaymentError):
        wallet.chain.verify_contract()


def test_actual_worker_process_kill_does_not_execute_twice(env, tmp_path):
    import subprocess
    import sys

    wallet = env["wallet"]
    cfg = wallet.config
    spec = TaskSpec(
        request_id="killed",
        chain_id=31337,
        contract=cfg.contract,
        token=cfg.token,
        client=wallet.chain.address,
        provider=env["accounts"]["seller"].address,
        evaluator=wallet.chain.address,
        amount_atomic=10000,
        deadline=env["w"].eth.get_block("latest").timestamp + 3600,
        tool="ask",
        arguments={"question": "kill"},
        acceptance="exact",
    )
    wallet.chain.fund(spec)
    env["http"].should_exit = True
    env["thread"].join(5)
    server = env["server"]
    server.store.add(spec, "seller", {})
    config_path = tmp_path / "worker.json"
    config_path.write_text(json.dumps(server.config.model_dump()))
    script = tmp_path / "worker.py"
    script.write_text("""
import asyncio,json,sys
from pathlib import Path
from mcp.types import Tool
from envarpay.tasks.config import TaskConfig
from envarpay.tasks.server import TaskServer
class Slow:
 async def list_tools(self):return [Tool(name="ask",inputSchema={"type":"object"})]
 async def call(self,name,arguments):
  with Path(sys.argv[2]).open("a") as f:f.write("started\\n")
  await asyncio.sleep(300)
async def main():
 s=TaskServer(TaskConfig.model_validate(json.loads(Path(sys.argv[1]).read_text())))
 s.backend=Slow()
 async with s.app().router.lifespan_context(s.app()):await asyncio.sleep(300)
asyncio.run(main())
""")
    marker = tmp_path / "starts.txt"
    process = subprocess.Popen([sys.executable, str(script), str(config_path), str(marker)])
    try:
        for _ in range(100):
            if marker.exists():
                break
            if process.poll() is not None:
                raise AssertionError("worker exited")
            time.sleep(0.05)
        assert marker.read_text() == "started\n"
        process.kill()
        process.wait(timeout=10)
        assert server.store.get_task(spec.job_id.hex())["status"] == "running"
        restarted = TaskServer(server.config)
        restarted.backend = env["backend"]
        asyncio.run(restarted.initialize())
        assert restarted.store.get_task(spec.job_id.hex())["status"] == "unknown"
        assert marker.read_text() == "started\n" and env["backend"].calls == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_evaluator_disabled_and_runtime_failure(env):
    wallet = env["wallet"]
    env["backend"].error = True
    wallet.purchase("seller", "ask", {"question": "fail"}, "exact", "failed")
    assert wait_result(wallet, "failed")["status"] == "failed"
    wallet.config.evaluator_enabled = False
    with pytest.raises(PaymentError):
        wallet.decide("failed", "reject", "failed")
    wallet.config.evaluator_enabled = True
    assert wallet.decide("failed", "reject", "runtime failure")["payment"]["status"] == "Rejected"
