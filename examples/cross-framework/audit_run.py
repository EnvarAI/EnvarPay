"""Read-only audit of a local matrix. Never signs, settles, or executes an agent.

Private ledgers and native events are inputs. Only the explicit public evidence
fields below are exported; signed payloads and credentials stay private.
"""

import argparse
import hashlib
import json
import sqlite3
import time
from itertools import permutations
from pathlib import Path

import httpx
from eth_utils import keccak

NAMES = ("openclaw", "hermes", "opencode", "goose", "langgraph", "pydantic-ai")
ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"


def operations(root, name, side):
    path = root / name / "state" / side / "payments.sqlite3"
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return [
            dict(r) | {"data": json.loads(r["data"])}
            for r in db.execute("SELECT * FROM operations")
        ]


def events(root, name, side):
    return [
        json.loads(line)
        for line in (root / name / f"{side}-evidence" / "events.jsonl").read_text().splitlines()
    ]


def native_calls(event):
    """Extract actual native dispatches, never prompt text that requested a call."""
    calls = []
    for item in event.get("tool_calls", []):
        name = item.get("name", "")
        args = item.get("args", item.get("arguments", {}))
        if name == "tool_call":  # OpenClaw's native MCP bridge
            name, args = args.get("id", ""), args.get("args", {})
        calls.append((name, args))
    for item in event.get("events", []):
        if item.get("type") != "tool_use":
            continue
        if "part" in item:  # OpenCode
            part = item["part"]
            calls.append((part.get("tool", ""), part.get("state", {}).get("input", {})))
        else:  # Hermes
            calls.append((item.get("name", ""), item.get("input", {})))
    for message in event.get("messages", []):
        if message.get("role") != "assistant":
            continue
        for item in message.get("content", []):
            if item.get("type") == "toolRequest":
                value = item["toolCall"]["value"]
                calls.append((value["name"], value["arguments"]))
    return [(name, args) for name, args in calls if "call_paid_tool" in name]


class Auditor:
    def __init__(self, url, proxy):
        self.url = url
        self.client = httpx.Client(timeout=30, proxy=proxy)

    def rpc(self, method, params):
        response = self.client.post(
            self.url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        )
        response.raise_for_status()
        value = response.json()
        if "error" in value or "result" not in value:
            raise RuntimeError(f"RPC audit failed: {method}")
        return value["result"]

    def receipt(self, tx, auth):
        # Deliberately independent of envarpay.Chain.validate_receipt.
        receipt = self.rpc("eth_getTransactionReceipt", [tx])
        assert receipt and int(receipt["status"], 16) == 1
        assert receipt["transactionHash"].lower() == tx.lower()
        block = self.rpc("eth_getBlockByNumber", [receipt["blockNumber"], False])
        assert block["hash"] == receipt["blockHash"]
        depth = int(self.rpc("eth_blockNumber", []), 16) - int(receipt["blockNumber"], 16) + 1
        assert depth >= 2
        payer = "0x" + auth["from"][2:].lower().zfill(64)
        payee = "0x" + auth["to"][2:].lower().zfill(64)
        transfer_topic = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
        nonce_topic = "0x" + keccak(text="AuthorizationUsed(address,bytes32)").hex()
        logs = [
            log
            for log in receipt["logs"]
            if log["address"].lower() == ASSET.lower() and not log.get("removed")
        ]
        transfers = [
            log
            for log in logs
            if [t.lower() for t in log["topics"]] == [transfer_topic, payer, payee]
            and len(log["data"]) == 66
            and int(log["data"], 16) == int(auth["value"]) == 100
        ]
        nonces = [
            log
            for log in logs
            if [t.lower() for t in log["topics"]] == [nonce_topic, payer, auth["nonce"].lower()]
        ]
        assert len(transfers) == len(nonces) == 1
        return {
            "transaction": tx,
            "block_number": int(receipt["blockNumber"], 16),
            "block_hash": block["hash"],
            "confirmations_at_audit": depth,
            "transfer_log_index": int(transfers[0]["logIndex"], 16),
            "authorization_log_index": int(nonces[0]["logIndex"], 16),
            "payer": auth["from"],
            "recipient": auth["to"],
            "amount_atomic": 100,
            "nonce": auth["nonce"],
        }

    def authorization_state(self, auth, block_tag):
        block = self.rpc("eth_getBlockByNumber", [block_tag, False])
        data = (
            "0x"
            + keccak(text="authorizationState(address,bytes32)")[:4].hex()
            + auth["from"][2:].lower().zfill(64)
            + auth["nonce"][2:]
        )
        state = self.rpc("eth_call", [{"to": ASSET, "data": data}, block["number"]])
        return {
            "block_tag": block_tag,
            "block_number": int(block["number"], 16),
            "block_hash": block["hash"],
            "block_timestamp": int(block["timestamp"], 16),
            "used_or_cancelled": bool(int(state, 16)),
            "past_authorization_expiry": int(block["timestamp"], 16) > int(auth["validBefore"]),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-state", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rpc", default="https://sepolia.base.org")
    parser.add_argument("--proxy")
    args = parser.parse_args()
    audit = Auditor(args.rpc, args.proxy)
    assert int(audit.rpc("eth_chainId", []), 16) == 84532
    buys = {n: operations(args.private_state, n, "buyer") for n in NAMES}
    sells = {n: operations(args.private_state, n, "seller") for n in NAMES}
    buy_events = {n: events(args.private_state, n, "buyer") for n in NAMES}
    sell_events = {n: events(args.private_state, n, "seller") for n in NAMES}
    passed, incomplete, transactions, nonces = [], [], set(), set()
    for buyer, seller in permutations(NAMES, 2):
        case = f"{buyer}-to-{seller}"
        request_id = f"matrix-20260929-{case}-v1"
        rows = [r for r in buys[buyer] if r["id"] == "buy:" + request_id]
        if not rows or rows[0]["status"] != "completed":
            failure = {
                "case": case,
                "request_id": request_id,
                "buyer_status": rows[0]["status"] if rows else "not_attempted",
                "reserved_atomic": rows[0]["amount"] if rows else 0,
            }
            if rows and rows[0]["data"].get("payload"):
                data = rows[0]["data"]
                auth = data["payload"]["payload"]["authorization"]
                question_hash = hashlib.sha256(data["arguments"]["question"].encode()).hexdigest()
                starts = [
                    e
                    for e in sell_events[seller]
                    if e["event"] == "seller_started" and e["question_sha256"] == question_hash
                ]
                response = data.get("response", {}).get("structuredContent") or {}
                failure.update(
                    {
                        "payer": auth["from"],
                        "recipient": auth["to"],
                        "nonce": auth["nonce"],
                        "valid_before": int(auth["validBefore"]),
                        "seller_execution_count": len(starts),
                        "facilitator_response": response.get("x402/payment-response"),
                        "latest_authorization_state": audit.authorization_state(auth, "latest"),
                        "finalized_authorization_state": audit.authorization_state(
                            auth, "finalized"
                        ),
                        "original_authorization_and_budget_preserved": True,
                    }
                )
            incomplete.append(failure)
            continue
        row = rows[0]
        assert row["amount"] == 100
        data = row["data"]
        auth = data["payload"]["payload"]["authorization"]
        original = json.loads((args.run_dir / f"{case}-proof.json").read_text())
        assert original["replay_no_new_payment_or_execution"] is True
        marker = f"ENVARPAY_{case}_RESULT=323"
        seller_rows = [r for r in sells[seller] if r["data"].get("arguments") == data["arguments"]]
        assert len(seller_rows) == 1 and seller_rows[0]["status"] == "completed"
        sd = seller_rows[0]["data"]
        assert sd["payload"] == data["payload"]
        assert sd["result"] == data["result"]["result"]
        assert data["result"]["payment_made"] is True
        assert marker in json.dumps(sd["result"])
        question_hash = hashlib.sha256(data["arguments"]["question"].encode()).hexdigest()
        starts = [
            e
            for e in sell_events[seller]
            if e["event"] == "seller_started" and e["question_sha256"] == question_hash
        ]
        deliveries = [
            e
            for e in sell_events[seller]
            if e["event"] == "seller_delivered" and marker in str(e["result"])
        ]
        received = [
            e
            for e in buy_events[buyer]
            if e["event"] == "buyer_delivered" and marker in str(e["result"])
        ]
        calls = [
            (name, call)
            for e in buy_events[buyer]
            if e["event"] == "native_run_finished"
            for name, call in native_calls(e)
            if call.get("request_id") == request_id
        ]
        assert len(starts) == len(deliveries) == len(received) == len(calls) == 1, case
        assert calls[0][1] == {
            "peer": seller,
            "tool": "ask_agent",
            "arguments": data["arguments"],
            "request_id": request_id,
        }
        assert sd["proof"]["verified_at"] <= sd["started_at"] <= starts[0]["at"]
        assert starts[0]["at"] <= deliveries[0]["at"] <= received[0]["at"]
        tx = data["result"]["payment"]["transaction"]
        assert tx == sd["transaction"] == original["proof"]["transaction"]
        assert tx not in transactions and auth["nonce"] not in nonces
        transactions.add(tx)
        nonces.add(auth["nonce"])
        proof = audit.receipt(tx, auth)
        passed.append(
            {
                "case": case,
                "request_id": request_id,
                "status": "passed",
                "proof": proof,
                "native_wallet_tool": calls[0][0],
                "expected_marker": marker,
                "seller_result": deliveries[0]["result"],
                "buyer_result": received[0]["result"],
                "seller_proof_verified_at": sd["proof"]["verified_at"],
                "seller_started_at": starts[0]["at"],
                "seller_delivered_at": deliveries[0]["at"],
                "buyer_delivered_at": received[0]["at"],
                "replay_no_new_payment_or_execution": True,
            }
        )
        print(f"Audited {case}: {tx}", flush=True)
    wallets = []
    for name in NAMES:
        address = next(
            r["data"]["payload"]["payload"]["authorization"]["from"]
            for r in buys[name]
            if r["data"].get("payload")
        )
        outgoing = sum(p["case"].startswith(name + "-to-") for p in passed)
        incoming = sum(p["case"].endswith("-to-" + name) for p in passed)
        balance = int(
            audit.rpc(
                "eth_call",
                [{"to": ASSET, "data": "0x70a08231" + address[2:].lower().zfill(64)}, "latest"],
            ),
            16,
        )
        assert balance == 500 + 100 * (incoming - outgoing)
        reserved = sum(r["amount"] for r in buys[name])
        assert reserved <= 500
        wallets.append(
            {
                "framework": name,
                "address": address,
                "balance_atomic": balance,
                "completed_purchases": outgoing,
                "completed_sales": incoming,
                "cumulative_reserved_atomic": reserved,
            }
        )
    result = {
        "audited_at": time.time(),
        "network": "eip155:84532",
        "asset": ASSET,
        "expected_directions": 30,
        "passed_directions": len(passed),
        "payment_amount_atomic": 100,
        "passed": passed,
        "incomplete": incomplete,
        "wallets": wallets,
        "scope": "Native Docker MCP paths; testnet only",
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Independent audit: {len(passed)}/30; {len(incomplete)} incomplete")


if __name__ == "__main__":
    main()
