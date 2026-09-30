"""Buyer task API with frozen policy, original-operation recovery and explicit decisions."""

from __future__ import annotations

from pathlib import Path

import httpx

from ..storage import PaymentError, secret_file
from .chain import Escrow
from .models import TaskSpec, commitment
from .store import TaskStore


class TaskWallet:
    def __init__(self, config):
        if not config.peers or config.backend:
            raise PaymentError("Task wallet requires a separate buyer configuration")
        self.config = config
        self.store = TaskStore(config.state_dir)
        self.chain = Escrow(config, self.store)

    def original(self, request_id):
        rows = [
            r
            for r in self.store.list_tasks(
                "reserved", "funded", "submitted", "completed", "rejected", "expired", "unknown"
            )
            if r["role"] == "buyer" and r["spec"]["request_id"] == request_id
        ]
        if len(rows) != 1:
            raise PaymentError("Unknown or ambiguous original task ID")
        return rows[0], TaskSpec.model_validate(rows[0]["spec"])

    def peer(self, name):
        if name not in self.config.peers:
            raise PaymentError("Task peer not approved by operator")
        return self.config.peers[name]

    def purchase(self, peer_name, tool, arguments, acceptance, request_id, duration=3600):
        peer, cfg = self.peer(peer_name), self.config
        if tool not in peer.tools or peer.tools[tool] > cfg.max_per_task_atomic:
            raise PaymentError("Task capability or fixed price outside policy")
        if not 60 <= duration <= cfg.max_duration_seconds:
            raise PaymentError("Task deadline outside policy")
        # Never generate a second deadline or terms when repeating the same ID.
        existing = [
            r
            for r in self.store.list_tasks(
                "reserved", "funded", "submitted", "completed", "rejected", "expired", "unknown"
            )
            if r["spec"]["request_id"] == request_id
        ]
        if existing:
            row = existing[0]
            spec = TaskSpec.model_validate(row["spec"])
            if (
                row["data"]["peer"],
                spec.tool,
                spec.arguments,
                spec.acceptance,
                row["data"]["duration"],
            ) != (peer_name, tool, arguments, acceptance, duration):
                raise PaymentError("Original task has different frozen terms")
            return self.status(request_id)
        if not cfg.signing_enabled:
            raise PaymentError("Task signing disabled")
        self.chain.verify_contract()
        now = self.chain.web3.eth.get_block("latest").timestamp
        spec = TaskSpec(
            request_id=request_id,
            chain_id=cfg.chain_id,
            contract=cfg.contract,
            token=cfg.token,
            client=self.chain.address,
            provider=peer.provider,
            evaluator=self.chain.address,
            amount_atomic=peer.tools[tool],
            deadline=now + duration,
            tool=tool,
            arguments=arguments,
            acceptance=acceptance,
        )
        self.store.add(
            spec,
            "buyer",
            {"peer": peer_name, "peer_snapshot": peer.model_dump(), "duration": duration},
            maximum=cfg.max_total_atomic,
        )
        return self.recover(request_id)

    def request(self, peer_name, method, path, body=None):
        peer = self.peer(peer_name)
        token = secret_file(Path(peer.token_file))
        if len(token) < 32:
            raise PaymentError("Task peer credential too short")
        with httpx.Client(
            timeout=self.config.timeout_seconds, trust_env=False, follow_redirects=False
        ) as client:
            with client.stream(
                method, peer.url + path, json=body, headers={"Authorization": "Bearer " + token}
            ) as response:
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > self.config.max_result_bytes + 131072:
                        raise PaymentError("Task response exceeds size limit")
                response.raise_for_status()
        import json

        return json.loads(data)

    def recover(self, request_id):
        row, spec = self.original(request_id)
        if self.peer(row["data"]["peer"]).model_dump() != row["data"]["peer_snapshot"]:
            raise PaymentError("Peer policy changed; inspect original task")
        if row["data"].get("decision"):
            decision = row["data"]["decision"]
            return self.decide(request_id, decision["action"], decision["reason"])
        state = self.chain.job(spec, latest=True)
        if state is None or state["status"] == "Open":
            if self.chain.web3.eth.get_block("latest").timestamp >= spec.deadline:
                raise PaymentError("Task expired before funding; inspect original transactions")
            proof = self.chain.fund(spec)
            self.store.transition(spec.job_id.hex(), "funded", funding_proof=proof)
        elif state["status"] == "Funded" and "funding_proof" not in row["data"]:
            proof = self.chain.fund(spec)  # only original signed transactions and receipts
            self.store.transition(spec.job_id.hex(), "funded", funding_proof=proof)
        state = self.chain.job(spec)
        if state and state["status"] == "Funded":
            self.request(row["data"]["peer"], "POST", "/tasks", spec.model_dump())
        return self.status(request_id)

    def status(self, request_id):
        row, spec = self.original(request_id)
        state = self.chain.job(spec)
        return {
            "request_id": request_id,
            "job_id": spec.job_id.hex(),
            "terms": spec.model_dump(),
            "local_status": row["status"],
            "payment": state,
            "funding_proof": row["data"].get("funding_proof"),
            "settlement_proof": row["data"].get("settlement_proof"),
        }

    def result(self, request_id):
        row, spec = self.original(request_id)
        peer = self.peer(row["data"]["peer"])
        if peer.model_dump() != row["data"]["peer_snapshot"]:
            raise PaymentError("Peer policy changed; inspect original task")
        result = self.request(row["data"]["peer"], "GET", "/tasks/" + spec.job_id.hex())
        if (
            result.get("id") != spec.job_id.hex()
            or result.get("terms_hash") != spec.terms_hash.hex()
        ):
            raise PaymentError("Seller response belongs to different task")
        if result.get("status") == "submitted":
            state = self.chain.job(spec)
            if (
                not state
                or state["status"] not in ("Submitted", "Completed")
                or commitment(result["result"]).hex() != state["deliverable"]
            ):
                raise PaymentError("Result does not match on-chain deliverable")
            self.store.transition(
                spec.job_id.hex(),
                None if row["status"] in ("completed", "rejected", "expired") else "submitted",
                result=result["result"],
                deliverable_hash=state["deliverable"],
            )
        return result

    def decide(self, request_id, decision, reason):
        if decision in ("accept", "reject") and not self.config.evaluator_enabled:
            raise PaymentError("Evaluator authority is disabled in this wallet policy")
        if (
            decision not in ("accept", "reject", "refund")
            or not isinstance(reason, str)
            or not 1 <= len(reason) <= 4000
        ):
            raise PaymentError("Explicit accept/reject/refund and bounded reason required")
        row, spec = self.original(request_id)
        state = self.chain.job(spec)
        if decision == "accept":
            if (
                not state
                or state["status"] not in ("Submitted", "Completed")
                or "result" not in row["data"]
            ):
                raise PaymentError("Retrieve and verify original deliverable before accepting")
            if commitment(row["data"]["result"]).hex() != state["deliverable"]:
                raise PaymentError("Stored result commitment differs")
        if decision == "reject" and (
            not state or state["status"] not in ("Funded", "Submitted", "Rejected")
        ):
            raise PaymentError("Only funded or submitted tasks can be rejected for refund")
        if decision == "refund" and (
            not state
            or state["status"] not in ("Funded", "Submitted", "Expired")
            or state["timestamp"] < spec.deadline
        ):
            raise PaymentError("Task has not reached its refund deadline")
        self.store.freeze_decision(spec.job_id.hex(), {"action": decision, "reason": reason})
        action = {"accept": "complete", "reject": "reject", "refund": "refundExpired"}[decision]
        proof = self.chain.verdict(
            spec, action, commitment({"decision": decision, "reason": reason})
        )
        self.store.transition(
            spec.job_id.hex(),
            {"accept": "completed", "reject": "rejected", "refund": "expired"}[decision],
            settlement_proof=proof,
        )
        if decision != "accept":
            self.store.release_refunded(spec.job_id.hex())
        return self.status(request_id)
