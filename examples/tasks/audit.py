"""Read-only second-RPC audit of a task's exact escrow transfers and canonical receipts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from web3 import Web3

from envarpay.tasks.chain import artifact
from envarpay.tasks.config import USDC
from envarpay.tasks.models import TaskSpec


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--evidence", type=Path, required=True, help="TaskWallet.status JSON")
    p.add_argument("--rpc", required=True, help="Independent RPC, different from transaction RPC")
    args = p.parse_args()
    d = json.loads(args.evidence.read_text())
    w = Web3(Web3.HTTPProvider(args.rpc, request_kwargs={"timeout": 30}))
    assert w.eth.chain_id == d["terms"]["chain_id"] == 84532
    assert d["terms"]["token"].lower() == USDC.lower()
    contract = w.eth.contract(address=d["terms"]["contract"], abi=artifact()["abi"])
    assert contract.functions.token().call().lower() == USDC.lower()
    spec = TaskSpec.model_validate(d["terms"])
    assert spec.job_id.hex() == d["job_id"]
    transfers = []
    topic = Web3.keccak(text="Transfer(address,address,uint256)")
    for kind in ("funding_proof", "settlement_proof"):
        proof = d[kind]
        assert proof is not None, "Only completed/refunded cases form complete acceptance evidence"
        if kind == "funding_proof":
            assert (proof["payer"], proof["recipient"]) == (spec.client, spec.contract)
        else:
            assert proof["payer"] == spec.contract
            assert proof["recipient"] in (spec.client, spec.provider)
        assert proof["amount_atomic"] == spec.amount_atomic
        r = w.eth.get_transaction_receipt(proof["transaction"])
        assert r.status == 1 and w.eth.get_block(r.blockNumber).hash == r.blockHash
        assert Web3.to_hex(r.blockHash) == proof["block_hash"]
        matches = [
            log
            for log in r.logs
            if log.address.lower() == USDC.lower()
            and not log.get("removed", False)
            and len(log.topics) == 3
            and log.topics[0] == topic
            and int.from_bytes(log.topics[1]) == int(proof["payer"], 16)
            and int.from_bytes(log.topics[2]) == int(proof["recipient"], 16)
            and int.from_bytes(log.data) == proof["amount_atomic"]
            and log.logIndex == proof["log_index"]
        ]
        assert len(matches) == 1
        transfers.append(
            {
                "kind": kind,
                "transaction": proof["transaction"],
                "confirmations": w.eth.block_number - r.blockNumber + 1,
            }
        )
    job = contract.functions.jobs(bytes.fromhex(d["job_id"])).call()
    assert job[0:3] == [d["terms"][key] for key in ("client", "provider", "evaluator")]
    assert job[3] == spec.amount_atomic and job[4] == spec.deadline
    assert job[5] == spec.terms_hash and job[7] in (3, 4, 5)
    assert d["settlement_proof"]["recipient"] == (spec.provider if job[7] == 3 else spec.client)
    print(
        json.dumps(
            {
                "independent_rpc": args.rpc,
                "chain_id": 84532,
                "verified_transfers": transfers,
                "job_status": job[7],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
