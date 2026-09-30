"""Durable task state using the existing private SQLite store and transactions."""

from __future__ import annotations

import json
import time

from ..storage import PaymentError, Store
from .models import TaskSpec


class TaskStore(Store):
    def __init__(self, directory):
        super().__init__(directory)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, role TEXT NOT NULL, binding TEXT NOT NULL,
                    spec TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
                    reserved INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_transactions (
                    id TEXT PRIMARY KEY, binding TEXT NOT NULL, tx_hash TEXT NOT NULL,
                    raw TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT);
            """)

    def get_task(self, job_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (job_id,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "spec": json.loads(row["spec"]), "data": json.loads(row["data"])}

    def add(self, spec: TaskSpec, role, data, *, maximum=0, capacity=0):
        key = spec.job_id.hex()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT binding,role FROM tasks WHERE id=?", (key,)).fetchone()
            if old:
                if old["binding"] != spec.binding or old["role"] != role:
                    raise PaymentError("Task ID already belongs to different frozen terms")
                return False
            amount = spec.amount_atomic if role == "buyer" else 0
            if role == "buyer":
                used = db.execute("SELECT COALESCE(SUM(reserved),0) FROM tasks").fetchone()[0]
                if used + amount > maximum:
                    raise PaymentError("Cumulative task budget exceeded")
            if capacity:
                count = db.execute(
                    "SELECT COUNT(*) FROM tasks WHERE role='seller' "
                    "AND status IN ('queued','running','delivered')"
                ).fetchone()[0]
                if count >= capacity:
                    raise PaymentError("Task queue is full")
            db.execute(
                "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)",
                (
                    key,
                    role,
                    spec.binding,
                    json.dumps(spec.model_dump()),
                    "reserved" if role == "buyer" else "queued",
                    json.dumps(data),
                    amount,
                    time.time(),
                ),
            )
        return True

    def transition(self, key, status, *, expected=None, **data):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status,data FROM tasks WHERE id=?", (key,)).fetchone()
            if not row:
                raise PaymentError("Unknown task")
            if expected is not None and row["status"] not in expected:
                return False
            merged = {**json.loads(row["data"]), **data}
            db.execute(
                "UPDATE tasks SET status=?,data=?,updated=? WHERE id=?",
                (status or row["status"], json.dumps(merged), time.time(), key),
            )
        return True

    def release_refunded(self, key):
        # Only caller with independently verified full refund may call this.
        with self.connect() as db:
            db.execute("UPDATE tasks SET reserved=0 WHERE id=? AND role='buyer'", (key,))

    def list_tasks(self, *statuses):
        with self.connect() as db:
            rows = db.execute(
                "SELECT id FROM tasks WHERE status IN ("
                + ",".join("?" for _ in statuses)
                + ") ORDER BY updated",
                statuses,
            ).fetchall()
        return [self.get_task(row["id"]) for row in rows]

    def freeze_decision(self, key, decision):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM tasks WHERE id=?", (key,)).fetchone()
            if not row:
                raise PaymentError("Unknown task")
            data = json.loads(row["data"])
            if data.get("decision") and data["decision"] != decision:
                raise PaymentError("Original evaluator decision already frozen")
            data["decision"] = decision
            db.execute("UPDATE tasks SET data=? WHERE id=?", (json.dumps(data), key))
