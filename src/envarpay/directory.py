"""Envar directory and optional observation reports; never a payment executor."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from urllib.parse import quote

import httpx

from .storage import PaymentError, secret_file

INVOCATION_META = "envar.ai/invocation"
RECOVERY_META = "envarpay/recovery-token"


class Envar:
    def __init__(self, connection, store):
        self.connection, self.store = connection, store

    async def request(self, method, path, *, body=None, key=None, authenticated=True):
        headers = {}
        if authenticated:
            token = secret_file(Path(self.connection.token_file))
            if not token.startswith("envar_agent_") or any(c in token for c in "\r\n"):
                raise PaymentError("Invalid Envar connection credential")
            headers["Authorization"] = "Bearer " + token
        if key:
            headers["Idempotency-Key"] = key
        async with asyncio.timeout(15):
            async with httpx.AsyncClient(
                timeout=15, trust_env=False, follow_redirects=False
            ) as http:
                async with http.stream(
                    method, self.connection.platform_url + path, headers=headers, json=body
                ) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 1_048_576:
                            raise PaymentError("Envar response is too large")
                    return json.loads(data)

    async def search(self, query):
        if not isinstance(query, str) or len(query) > 200:
            raise PaymentError("Search query must be at most 200 characters")
        result = await self.request(
            "GET", "/api/v1/directory?q=" + quote(query), authenticated=False
        )
        return {"candidates": result.get("items", []), "payment_authorized": False}

    async def get(self, handle):
        if not isinstance(handle, str) or len(handle) > 100:
            raise PaymentError("Invalid Agent handle")
        return await self.request(
            "GET", "/api/v1/public/agents/" + quote(handle, safe=""), authenticated=False
        )

    async def create_invocation(self, key):
        row = self.store.get(key)
        data = row["data"]
        if data.get("invocation_id"):
            return data["invocation_id"]
        if not data.get("invocation_request"):
            return None
        request_key = str(uuid.uuid5(uuid.UUID(self.connection.agent_id), key))
        result = await self.request(
            "POST", "/api/v1/invocations", body=data["invocation_request"], key=request_key
        )
        invocation_id = str(uuid.UUID(result["id"]))
        self.store.update(key, None, invocation_id=invocation_id)
        return invocation_id

    async def flush(self):
        delivered = 0
        for row in self.store.pending_reports():
            try:
                invocation = await self.create_invocation(row["id"])
                if not invocation:
                    continue
                for event in row["data"]["outbox"]:
                    await self.request(
                        "POST", f"/api/v1/invocations/{invocation}/reports", body=event
                    )
                    self.store.acknowledge_event(row["id"], event["event_id"])
                    delivered += 1
            except Exception:
                # Keep the original persisted event. Never buy, sign or execute in a reporter.
                continue
        return {"delivered": delivered, "pending": len(self.store.pending_reports())}
