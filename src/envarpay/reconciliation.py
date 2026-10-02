"""Explicit operator reconciliation of expired, unused original authorizations."""

from __future__ import annotations

from urllib.parse import urlsplit

from .chain import Chain
from .config import Config, address, secure_url
from .storage import PaymentError, Store, digest


async def release_unpaid(config: Config, operation_id: str, independent_rpc: str) -> dict:
    independent_rpc = secure_url(independent_rpc)
    if urlsplit(independent_rpc).hostname == urlsplit(config.rpc_url).hostname:
        raise PaymentError("An independently operated RPC host is required")
    store = Store(config.state_dir)
    row = store.get(operation_id)
    if not row or not operation_id.startswith("buy:"):
        raise PaymentError("An original buyer operation is required")
    if row["status"] == "refused" and row["data"].get("nonpayment_proof"):
        return {"operation_id": operation_id, "status": "refused", "reservation_released": True}
    data = row["data"]
    if (
        row["status"] != "unknown"
        or row["amount"] <= 0
        or data.get("payment_state") == "confirmed"
        or data.get("execution_state", "not_started") != "not_started"
    ):
        raise PaymentError("Only unresolved, unconfirmed buyer reservations can be reconciled")
    try:
        payload = data["payload"]
        requirements = data["requirements"]
        authorization = payload["payload"]["authorization"]
        for terms in (requirements, payload["accepted"]):
            if (
                terms["network"] != config.network
                or address(terms["asset"]) != address(config.asset)
                or terms["scheme"] != "exact"
                or address(terms["payTo"]) != address(authorization["to"])
                or int(terms["amount"]) != row["amount"]
            ):
                raise PaymentError(
                    "Original authorization terms do not match this chain/reservation"
                )
        if int(authorization["value"]) != row["amount"]:
            raise PaymentError("Original authorization amount does not match reservation")
    except (KeyError, TypeError, ValueError) as error:
        raise PaymentError("Complete original authorization and terms are required") from error
    proofs = []
    for rpc in (config.rpc_url, independent_rpc):
        proof = await Chain(config.model_copy(update={"rpc_url": rpc})).prove_unused_expired(
            authorization
        )
        parsed = urlsplit(rpc)
        proof["rpc_origin"] = f"{parsed.scheme}://{parsed.netloc}"
        proofs.append(proof)
    proof = {"payload_sha256": digest(payload), "checks": proofs}
    store.release_unpaid(operation_id, row, proof)
    return {
        "operation_id": operation_id,
        "status": "refused",
        "reservation_released": True,
        "proof": proof,
    }
