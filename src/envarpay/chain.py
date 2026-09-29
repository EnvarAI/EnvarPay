"""Independent USDC receipt checks, including the authorization nonce."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from eth_utils import keccak

from .config import Config, address
from .storage import PaymentError


class Chain:
    def __init__(self, config: Config):
        self.config = config

    async def rpc(self, method: str, params: list) -> Any:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.config.rpc_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params,
                },
            )
            response.raise_for_status()
            data = response.json()
        if "error" in data or "result" not in data:
            raise PaymentError("RPC failed; preserve the original payment and inspect status")
        return data["result"]

    async def check_network(self) -> None:
        if int(await self.rpc("eth_chainId", []), 16) != self.config.chain_id:
            raise PaymentError("RPC chain does not match the configured network")

    async def prove(self, tx: str, authorization: dict) -> dict:
        await self.check_network()
        if len(tx) != 66 or not tx.startswith("0x"):
            raise PaymentError("Invalid settlement transaction hash")
        end = time.monotonic() + self.config.timeout_seconds
        while True:
            receipt = await self.rpc("eth_getTransactionReceipt", [tx])
            if receipt:
                latest = int(await self.rpc("eth_blockNumber", []), 16)
                if latest - int(receipt["blockNumber"], 16) + 1 >= self.config.confirmations:
                    break
            if time.monotonic() >= end:
                raise PaymentError("Receipt remains unconfirmed; do not sign again")
            await asyncio.sleep(1)
        block = await self.rpc("eth_getBlockByNumber", [receipt["blockNumber"], False])
        log_index = self.validate_receipt(receipt, tx, authorization)
        if not block or block["hash"].lower() != receipt["blockHash"].lower():
            raise PaymentError("Receipt is not on the current canonical chain")
        return {
            "network": self.config.network,
            "transaction": tx,
            "asset": self.config.asset,
            "payer": address(authorization["from"]),
            "recipient": address(authorization["to"]),
            "amount_atomic": str(authorization["value"]),
            "nonce": authorization["nonce"],
            "block_number": int(receipt["blockNumber"], 16),
            "block_hash": receipt["blockHash"],
            "log_index": log_index,
            "confirmations": self.config.confirmations,
            "verified_at": time.time(),
        }

    async def find_authorization(self, authorization: dict, from_block: int) -> str | None:
        await self.check_network()
        latest = int(await self.rpc("eth_blockNumber", []), 16)
        if from_block < 0 or latest - from_block > 50000:
            raise PaymentError("Original payment needs a bounded chain audit")
        used = "0x" + keccak(text="AuthorizationUsed(address,bytes32)").hex()
        payer = "0x" + address(authorization["from"])[2:].lower().zfill(64)
        logs = await self.rpc(
            "eth_getLogs",
            [
                {
                    "address": self.config.asset,
                    "fromBlock": hex(from_block),
                    "toBlock": hex(latest),
                    "topics": [used, payer, authorization["nonce"]],
                }
            ],
        )
        transactions = {log["transactionHash"] for log in logs if not log.get("removed")}
        if len(transactions) > 1:
            raise PaymentError("Ambiguous authorization history")
        return next(iter(transactions), None)

    def validate_receipt(self, receipt: dict, tx: str, authorization: dict) -> int:
        return verify_usdc_receipt(receipt, tx, self.config.asset, authorization)


def verify_usdc_receipt(receipt: dict, tx: str, asset: str, authorization: dict) -> int:
    """Verify transfer identity without constructing a wallet or reading a signing key."""
    if int(receipt["status"], 16) != 1 or receipt["transactionHash"].lower() != tx.lower():
        raise PaymentError("Transaction did not succeed")
    payer = "0x" + address(authorization["from"])[2:].lower().zfill(64)
    recipient = "0x" + address(authorization["to"])[2:].lower().zfill(64)
    transfer = "0x" + keccak(text="Transfer(address,address,uint256)").hex()
    used = "0x" + keccak(text="AuthorizationUsed(address,bytes32)").hex()
    logs = [
        log
        for log in receipt["logs"]
        if log["address"].lower() == asset.lower() and not log.get("removed")
    ]
    transfers = [
        log
        for log in logs
        if [t.lower() for t in log["topics"]] == [transfer, payer, recipient]
        and len(log["data"]) == 66
        and int(log["data"], 16) == int(authorization["value"])
    ]
    nonces = [
        log
        for log in logs
        if [t.lower() for t in log["topics"]] == [used, payer, authorization["nonce"].lower()]
    ]
    if len(transfers) != 1 or len(nonces) != 1:
        raise PaymentError("Exact USDC Transfer and original AuthorizationUsed nonce required")
    return int(transfers[0]["logIndex"], 16)
