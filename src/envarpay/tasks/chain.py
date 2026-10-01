"""Pinned experimental escrow, durable signed transactions and independent receipt checks."""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from importlib.resources import files
from pathlib import Path

from eth_account import Account
from eth_utils import keccak
from web3 import Web3
from web3.exceptions import TransactionNotFound

from ..storage import PaymentError, digest, secret_file
from .models import TaskSpec


def artifact():
    return json.loads(files("envarpay.tasks").joinpath("escrow.json").read_text())


@contextmanager
def exclusive(path):
    import fcntl
    import os

    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise PaymentError(
                "Task wallet/service already in use; query original operation"
            ) from None
        yield
    finally:
        os.close(fd)


class Escrow:
    def __init__(self, config, store):
        self.config, self.store = config, store
        self.web3 = Web3(Web3.HTTPProvider(config.rpc_url, request_kwargs={"timeout": 30}))
        self.account = Account.from_key(secret_file(Path(config.key_file)))
        self.contract = self.web3.eth.contract(address=config.contract, abi=artifact()["abi"])

    @property
    def address(self):
        return self.account.address

    def verify_contract(self):
        w, cfg = self.web3, self.config
        if w.eth.chain_id != cfg.chain_id:
            raise PaymentError("Wrong task network")
        runtime = bytearray(w.eth.get_code(cfg.contract))
        pinned = artifact()["evm"]["deployedBytecode"]
        expected = bytearray.fromhex(pinned["object"])
        if len(runtime) != len(expected):
            raise PaymentError("Unrecognized escrow bytecode")
        for refs in pinned["immutableReferences"].values():
            for ref in refs:
                start, length = ref["start"], ref["length"]
                # All immutables in this version contain only the configured token.
                if int.from_bytes(runtime[start : start + length]) != int(cfg.token, 16):
                    raise PaymentError("Escrow immutable token mismatch")
                runtime[start : start + length] = expected[start : start + length]
        if runtime != expected or self.contract.functions.token().call() != cfg.token:
            raise PaymentError("Unrecognized escrow implementation/token")

    def confirmed_block(self):
        number = self.web3.eth.block_number - self.config.confirmations + 1
        if number < 0:
            raise PaymentError("No confirmed block available")
        return self.web3.eth.get_block(number)

    def job(self, spec: TaskSpec, *, latest=False):
        self.verify_contract()
        cfg = self.config
        if (spec.chain_id, spec.contract, spec.token) != (cfg.chain_id, cfg.contract, cfg.token):
            raise PaymentError("Task outside configured chain/contract/token")
        block = self.web3.eth.get_block("latest") if latest else self.confirmed_block()
        data = self.contract.functions.jobs(spec.job_id).call(block_identifier=block.number)
        if data[0] == "0x" + "0" * 40:
            return None
        expected = [
            spec.client,
            spec.provider,
            spec.evaluator,
            spec.amount_atomic,
            spec.deadline,
            spec.terms_hash,
        ]
        if list(data[:6]) != expected:
            raise PaymentError("On-chain job differs from frozen task terms")
        if self.web3.eth.get_block(block.number).hash != block.hash:
            raise PaymentError("Task snapshot was reorganized")
        return {
            "status": ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"][data[7]],
            "deliverable": bytes(data[6]).hex(),
            "timestamp": block.timestamp,
            "block": block.number,
        }

    def receipt(self, tx_hash):
        w = self.web3
        deadline = time.monotonic() + self.config.timeout_seconds
        while time.monotonic() < deadline:
            try:
                r = w.eth.get_transaction_receipt(tx_hash)
            except Exception:
                r = None
            if r and w.eth.block_number - r.blockNumber + 1 >= self.config.confirmations:
                if r.status != 1:
                    raise PaymentError("Task transaction reverted; preserve its hash")
                if w.eth.get_block(r.blockNumber).hash != r.blockHash:
                    raise PaymentError("Task transaction is not canonical")
                return r
            time.sleep(0.5)
        raise PaymentError("Task transaction unresolved; recover original hash, never replace")

    def send(self, action, fn):
        self.verify_contract()
        if not self.config.signing_enabled:
            raise PaymentError("Task signing disabled")
        with exclusive(self.store.path.parent / "task-signer.lock"):
            calldata = fn._encode_transaction_data()
            binding = digest([self.config.chain_id, self.address, fn.address, calldata])
            with self.store.connect() as db:
                old = db.execute("SELECT * FROM task_transactions WHERE id=?", (action,)).fetchone()
            if old:
                if old["binding"] != binding:
                    raise PaymentError("Original transaction bound to different calldata")
                # Query first. Do not re-submit a transaction already known to the node.
                if old["status"] != "confirmed":
                    try:
                        self.web3.eth.get_transaction(old["tx_hash"])
                    except TransactionNotFound:
                        self.web3.eth.send_raw_transaction(bytes.fromhex(old["raw"]))
                r = self.receipt(old["tx_hash"])
            else:
                with self.store.connect() as db:
                    pending = db.execute(
                        "SELECT id FROM task_transactions WHERE status!='confirmed' LIMIT 1"
                    ).fetchone()
                if pending:
                    raise PaymentError(
                        "An earlier task transaction is unresolved; reconcile it first"
                    )
                gas_price = self.web3.eth.gas_price
                if gas_price > self.config.max_gas_price_wei:
                    raise PaymentError("Task gas price exceeds policy")
                gas = int(fn.estimate_gas({"from": self.address}) * 1.2) + 5000
                if gas > self.config.max_gas_per_transaction:
                    raise PaymentError("Task gas estimate exceeds policy")
                tx = fn.build_transaction(
                    {
                        "from": self.address,
                        "chainId": self.config.chain_id,
                        "nonce": self.web3.eth.get_transaction_count(self.address, "pending"),
                        "gas": gas,
                        "gasPrice": gas_price,
                    }
                )
                signed = self.account.sign_transaction(tx)
                tx_hash = Web3.to_hex(signed.hash)
                with self.store.connect() as db:
                    db.execute(
                        "INSERT INTO task_transactions VALUES(?,?,?,?, 'signed',NULL)",
                        (action, binding, tx_hash, signed.raw_transaction.hex()),
                    )
                self.web3.eth.send_raw_transaction(signed.raw_transaction)
                r = self.receipt(tx_hash)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE task_transactions SET status='confirmed',receipt=? WHERE id=?",
                    (Web3.to_json(r), action),
                )
            return r

    def transfer(self, receipt, payer, payee, amount):
        topic = keccak(text="Transfer(address,address,uint256)")
        matches = [
            log
            for log in receipt.logs
            if log.address.lower() == self.config.token.lower()
            and not log.get("removed", False)
            and len(log.topics) == 3
            and log.topics[0] == topic
            and int.from_bytes(log.topics[1]) == int(payer, 16)
            and int.from_bytes(log.topics[2]) == int(payee, 16)
            and len(log.data) == 32
            and int.from_bytes(log.data) == amount
        ]
        if len(matches) != 1:
            raise PaymentError("Exact task USDC transfer missing")
        return {
            "transaction": Web3.to_hex(receipt.transactionHash),
            "block": receipt.blockNumber,
            "block_hash": Web3.to_hex(receipt.blockHash),
            "log_index": matches[0].logIndex,
            "payer": payer,
            "recipient": payee,
            "amount_atomic": amount,
        }

    def fund(self, spec):
        if self.address != spec.client or spec.evaluator != spec.client:
            raise PaymentError("First task version requires buyer-owned evaluator")
        ident = spec.job_id.hex()
        j = self.job(spec, latest=True)
        with self.store.connect() as db:
            created = db.execute(
                "SELECT id FROM task_transactions WHERE id=?", (ident + ":create",)
            ).fetchone()
        if j is not None and not created:
            raise PaymentError("Job already exists without an original local creation record")
        if j is None or created:
            self.send(
                ident + ":create",
                self.contract.functions.create(
                    spec.job_id,
                    spec.provider,
                    spec.evaluator,
                    spec.amount_atomic,
                    spec.deadline,
                    spec.terms_hash,
                ),
            )
        erc20 = self.web3.eth.contract(
            address=self.config.token,
            abi=[
                {
                    "type": "function",
                    "name": "approve",
                    "inputs": [
                        {"name": "spender", "type": "address"},
                        {"name": "amount", "type": "uint256"},
                    ],
                    "outputs": [{"type": "bool"}],
                    "stateMutability": "nonpayable",
                }
            ],
        )
        # Both operations replay saved receipts, never sign a fresh approval on retry.
        self.send(
            ident + ":approve", erc20.functions.approve(self.config.contract, spec.amount_atomic)
        )
        r = self.send(
            ident + ":fund", self.contract.functions.fund(spec.job_id, spec.amount_atomic)
        )
        return self.transfer(r, spec.client, self.config.contract, spec.amount_atomic)

    def submit(self, spec, result_hash):
        if self.address != spec.provider:
            raise PaymentError("Only configured provider can submit")
        return self.send(
            spec.job_id.hex() + ":submit", self.contract.functions.submit(spec.job_id, result_hash)
        )

    def verdict(self, spec, action, reason):
        if self.address != spec.evaluator:
            raise PaymentError("Only configured evaluator can decide")
        if action not in ("complete", "reject", "refundExpired"):
            raise PaymentError("Invalid task decision")
        fn = getattr(self.contract.functions, action)
        r = self.send(
            spec.job_id.hex() + ":" + action,
            fn(spec.job_id) if action == "refundExpired" else fn(spec.job_id, reason),
        )
        return self.transfer(
            r,
            self.config.contract,
            spec.provider if action == "complete" else spec.client,
            spec.amount_atomic,
        )
