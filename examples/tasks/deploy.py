"""Explicit Base Sepolia deployment with durable original signed bytes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from eth_account import Account
from web3 import Web3
from web3.exceptions import TransactionNotFound

from envarpay.storage import PaymentError, Store, secret_file
from envarpay.tasks.chain import artifact, exclusive
from envarpay.tasks.config import USDC


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rpc", default="https://sepolia.base.org")
    p.add_argument("--key-file", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--execute", action="store_true")
    args = p.parse_args()
    account = Account.from_key(secret_file(args.key_file))
    w = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 30}))
    if w.eth.chain_id != 84532:
        raise PaymentError("Deployment restricted to Base Sepolia")
    a = artifact()
    factory = w.eth.contract(abi=a["abi"], bytecode=a["evm"]["bytecode"]["object"])
    constructor = factory.constructor(USDC)
    if not args.execute:
        print(
            json.dumps(
                {
                    "chain_id": 84532,
                    "deployer": account.address,
                    "eth_wei": w.eth.get_balance(account.address),
                    "signing": False,
                }
            )
        )
        return
    store = Store(str(args.state))
    record = store.path.parent / "deployment.json"
    with exclusive(store.path.parent / "deploy.lock"):
        if record.exists():
            d = json.loads(record.read_text())
            if d["chain_id"] != 84532 or d["deployer"] != account.address:
                raise PaymentError("Existing deployment belongs to another wallet/network")
            try:
                w.eth.get_transaction(d["hash"])
            except TransactionNotFound:
                w.eth.send_raw_transaction(bytes.fromhex(d["raw"]))
        else:
            gas_price = w.eth.gas_price
            gas = int(constructor.estimate_gas({"from": account.address}) * 1.2) + 5000
            if gas_price > 2000000000 or gas > 3000000:
                raise PaymentError("Deployment gas exceeds test policy")
            tx = constructor.build_transaction(
                {
                    "from": account.address,
                    "chainId": 84532,
                    "nonce": w.eth.get_transaction_count(account.address, "pending"),
                    "gas": gas,
                    "gasPrice": gas_price,
                }
            )
            signed = account.sign_transaction(tx)
            d = {
                "chain_id": 84532,
                "deployer": account.address,
                "hash": Web3.to_hex(signed.hash),
                "raw": signed.raw_transaction.hex(),
            }
            # Exclusive private directory and owner-only raw transaction record.
            with record.open("x") as f:
                record.chmod(0o600)
                json.dump(d, f)
            w.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w.eth.wait_for_transaction_receipt(d["hash"], timeout=180)
        if receipt.status != 1 or w.eth.get_block(receipt.blockNumber).hash != receipt.blockHash:
            raise PaymentError("Deployment receipt failed/canonical check failed")
        public = {
            "chain_id": 84532,
            "deployer": account.address,
            "transaction": d["hash"],
            "contract": receipt.contractAddress,
            "token": USDC,
            "block": receipt.blockNumber,
        }
        (store.path.parent / "deployment-public.json").write_text(json.dumps(public, indent=2))
        print(json.dumps(public, indent=2))


if __name__ == "__main__":
    main()
