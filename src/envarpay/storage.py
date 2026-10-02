"""Local durable reservations; ambiguous attempts never release their budget automatically."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class PaymentError(RuntimeError):
    """A safe, user-visible payment refusal."""


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def secret_file(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise PaymentError("Secret file must be a regular, owner-only file (chmod 600)")
    return path.read_text().strip()


class Store:
    def __init__(self, directory: str):
        path = Path(directory)
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink() or path.stat().st_mode & 0o077:
            raise PaymentError("State directory must be private (chmod 700)")
        self.path = path / "payments.sqlite3"
        if self.path.is_symlink():
            raise PaymentError("State database cannot be a symbolic link")
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        self.path.chmod(0o600)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, binding TEXT NOT NULL, status TEXT NOT NULL,
                amount INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, updated REAL NOT NULL)""")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, key: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM operations WHERE id=?", (key,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "data": json.loads(row["data"])}

    def claim(self, key: str, binding: str, data: dict) -> None:
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                pending = db.execute(
                    "SELECT id FROM operations WHERE binding=? AND id LIKE 'buy:%' "
                    "AND status NOT IN ('completed', 'refused') LIMIT 1",
                    (binding,),
                ).fetchone()
                if key.startswith("buy:") and pending:
                    raise PaymentError(
                        "Same purchase has an unresolved attempt; do not use a new ID"
                    )
                db.execute(
                    "INSERT INTO operations VALUES (?, ?, 'reserved', 0, ?, ?)",
                    (key, binding, json.dumps(data), time.time()),
                )
        except sqlite3.IntegrityError as error:
            raise PaymentError(
                "Request already attempted; use status with the original request ID"
            ) from error

    def reserve_budget(self, key: str, amount: int, maximum: int) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT amount,status FROM operations WHERE id=?", (key,)).fetchone()
            if not row or row["amount"] or row["status"] != "reserved":
                raise PaymentError("This request already reserved a signature")
            used = db.execute(
                "SELECT COALESCE(SUM(amount),0) FROM operations WHERE id LIKE 'buy:%'"
            ).fetchone()[0]
            if amount <= 0 or used + amount > maximum:
                raise PaymentError("Cumulative wallet budget exceeded")
            db.execute(
                "UPDATE operations SET amount=?,status='signing',updated=? WHERE id=?",
                (amount, time.time(), key),
            )

    def update(
        self, key: str, status: str | None, *, expected: set[str] | None = None, **data: Any
    ) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data,status FROM operations WHERE id=?", (key,)).fetchone()
            if not row:
                raise PaymentError("Missing operation reservation")
            if expected is not None and row["status"] not in expected:
                return False
            merged = {**json.loads(row["data"]), **data}
            db.execute(
                "UPDATE operations SET status=?,data=?,updated=? WHERE id=?",
                (status or row["status"], json.dumps(merged), time.time(), key),
            )
            return True

    def release_unpaid(self, key: str, expected: dict, proof: dict) -> None:
        """CAS the audited operation while retaining its original payload and amount."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM operations WHERE id=?", (key,)).fetchone()
            if not row:
                raise PaymentError("Missing original operation")
            data = json.loads(row["data"])
            if (
                row["status"] != "unknown"
                or row["status"] != expected["status"]
                or row["binding"] != expected["binding"]
                or row["amount"] != expected["amount"]
                or data != expected["data"]
            ):
                raise PaymentError("Operation changed during audit; retain reservation and recheck")
            data.update(
                original_reserved_atomic=row["amount"],
                nonpayment_proof=proof,
                payment_state="not_paid",
                execution_state="not_started",
            )
            db.execute(
                "UPDATE operations SET status='refused',amount=0,data=?,updated=? WHERE id=?",
                (json.dumps(data), time.time(), key),
            )

    def queue_event(self, key: str, kind: str, payload: dict) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM operations WHERE id=?", (key,)).fetchone()
            if not row:
                raise PaymentError("Missing operation reservation")
            data = json.loads(row["data"])
            events = data.setdefault("outbox", [])
            if len(events) >= 64:
                raise PaymentError("Too many pending reports; synchronize the original operation")
            events.append({"event_id": str(uuid.uuid4()), "kind": kind, "payload": payload})
            db.execute("UPDATE operations SET data=? WHERE id=?", (json.dumps(data), key))

    def pending_reports(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM operations "
                "WHERE json_array_length(json_extract(data, '$.outbox')) > 0 "
                "ORDER BY updated LIMIT 1000"
            ).fetchall()
        return [
            {**dict(row), "data": json.loads(row["data"])}
            for row in rows
            if json.loads(row["data"]).get("outbox")
        ]

    def acknowledge_event(self, key: str, event_id: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM operations WHERE id=?", (key,)).fetchone()
            data = json.loads(row["data"])
            data["outbox"] = [e for e in data.get("outbox", []) if e["event_id"] != event_id]
            db.execute("UPDATE operations SET data=? WHERE id=?", (json.dumps(data), key))

    def public_status(self, key: str | None = None) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT id,status,amount,updated,data FROM operations ORDER BY updated DESC"
            ).fetchall()
        return [
            {k: row[k] for k in ("id", "status", "amount", "updated")}
            | {
                field: json.loads(row["data"]).get(field)
                for field in ("transaction", "payment_state", "execution_state", "invocation_id")
            }
            | {"report_pending": bool(json.loads(row["data"]).get("outbox"))}
            for row in rows
            if key is None or row["id"] == key
        ]
