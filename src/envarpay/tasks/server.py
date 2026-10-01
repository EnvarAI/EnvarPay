"""Bounded asynchronous task server over HTTP, using existing AgentBackend adapters."""

from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from jsonschema.validators import validator_for
from pydantic import ValidationError
from referencing import Registry
from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..backend import AgentBackend
from ..storage import PaymentError, secret_file
from .chain import Escrow, exclusive
from .models import TaskSpec, canonical, commitment
from .store import TaskStore


class TaskServer:
    def __init__(self, config):
        if not config.backend or not config.clients:
            raise PaymentError("Task server requires backend and authenticated clients")
        self.config = config
        self.store = TaskStore(config.state_dir)
        self.chain = Escrow(config, self.store)
        self.backend = AgentBackend(config.backend, config.timeout_seconds)
        self.tools = {}
        self.credentials = {}
        for client in config.clients.values():
            token = secret_file(Path(client.token_file))
            if len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token):
                raise PaymentError(
                    "Task client credential must be at least 32 printable characters"
                )
            if token in self.credentials:
                raise PaymentError("Task client credentials must be unique")
            self.credentials[token] = client.address

    def authenticate(self, request):
        header = request.headers.get("authorization", "")
        for token, address in self.credentials.items():
            if secrets.compare_digest(header, "Bearer " + token):
                return address
        raise PermissionError("Task authentication required")

    def public(self, row):
        spec = TaskSpec.model_validate(row["spec"])
        return {
            "id": row["id"],
            "terms_hash": spec.terms_hash.hex(),
            "status": row["status"],
            "result": row["data"].get("result") if row["status"] == "submitted" else None,
            "error": row["data"].get("error"),
        }

    async def initialize(self):
        if not self.config.signing_enabled:
            raise PaymentError("Task seller signing must be explicitly enabled")
        await asyncio.to_thread(self.chain.verify_contract)
        available = {t.name: t for t in await self.backend.list_tools()}
        if not set(self.config.tools) <= available.keys():
            raise PaymentError("A priced task capability is missing")
        self.tools = {name: available[name] for name in self.config.tools}
        # Holding a process lock prevents a second server from cancelling active work.
        for row in self.store.list_tasks("running"):
            self.store.transition(
                row["id"],
                "unknown",
                expected={"running"},
                error="Execution interrupted; inspect original runtime, never replay automatically",
            )

    async def verify_funded(self, spec):
        state = await asyncio.to_thread(self.chain.job, spec)
        latest = await asyncio.to_thread(self.chain.job, spec, latest=True)
        if (
            not state
            or not latest
            or state["status"] != "Funded"
            or latest["status"] != "Funded"
            or latest["timestamp"] >= spec.deadline
        ):
            raise PaymentError("Task is not funded and unexpired on the configured chain")

    async def create(self, request):
        try:
            owner = self.authenticate(request)
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 80000:
                    return JSONResponse({"error": "Task body exceeds limit"}, 413)
            spec = TaskSpec.model_validate_json(body)
            if (
                spec.client != owner
                or spec.evaluator != owner
                or spec.provider != self.chain.address
            ):
                return JSONResponse({"error": "Task roles outside authenticated policy"}, 403)
            if self.config.tools.get(spec.tool) != spec.amount_atomic:
                return JSONResponse(
                    {"error": "Task capability or price outside seller policy"}, 403
                )
            validator_for(self.tools[spec.tool].inputSchema)(
                self.tools[spec.tool].inputSchema, registry=Registry()
            ).validate(spec.arguments)
            row = self.store.get_task(spec.job_id.hex())
            if row:
                if row["binding"] != spec.binding:
                    return JSONResponse({"error": "Task ID already has different terms"}, 409)
                return JSONResponse(self.public(row))
            await self.verify_funded(spec)
            latest = await asyncio.to_thread(self.chain.web3.eth.get_block, "latest")
            if spec.deadline - latest.timestamp > self.config.max_duration_seconds:
                raise PaymentError("Task duration exceeds seller policy")
            added = self.store.add(spec, "seller", {}, capacity=self.config.max_pending)
            return JSONResponse(
                self.public(self.store.get_task(spec.job_id.hex())), 202 if added else 200
            )
        except PermissionError:
            return JSONResponse({"error": "Task authentication required"}, 401)
        except (ValidationError, ValueError):
            return JSONResponse({"error": "Invalid task request"}, 400)
        except PaymentError as error:
            return JSONResponse({"error": str(error)}, 409)
        except Exception:
            return JSONResponse({"error": "Task verification unavailable"}, 503)

    async def get(self, request):
        try:
            owner = self.authenticate(request)
        except PermissionError:
            return JSONResponse({"error": "Task authentication required"}, 401)
        row = self.store.get_task(request.path_params["job_id"])
        if not row or row["spec"]["client"] != owner:
            return JSONResponse({"error": "Task not found"}, 404)
        return JSONResponse(self.public(row), headers={"Cache-Control": "no-store"})

    async def execute(self, row):
        spec, key = TaskSpec.model_validate(row["spec"]), row["id"]
        if row["status"] == "queued":
            try:
                state = await asyncio.to_thread(self.chain.job, spec)
                if state and (
                    state["status"] in ("Rejected", "Expired", "Completed")
                    or state["timestamp"] >= spec.deadline
                ):
                    self.store.transition(
                        key, "aborted", expected={"queued"}, error="Task ended before execution"
                    )
                    return
                await self.verify_funded(spec)
            except Exception:
                return
            if not self.store.transition(key, "running", expected={"queued"}):
                return
            try:
                result = await asyncio.wait_for(
                    self.backend.call(spec.tool, spec.arguments), self.config.timeout_seconds
                )
                if result.isError:
                    self.store.transition(
                        key,
                        "failed",
                        expected={"running"},
                        error="Runtime failed; evaluator must reject or await refund",
                    )
                    return
                value = result.model_dump(mode="json", by_alias=True)
                if len(canonical(value)) > self.config.max_result_bytes:
                    raise PaymentError("Task result exceeds configured limit")
                self.store.transition(key, "delivered", expected={"running"}, result=value)
            except BaseException as error:
                self.store.transition(
                    key,
                    "unknown",
                    expected={"running"},
                    error="Runtime outcome uncertain; inspect original execution",
                )
                if isinstance(error, asyncio.CancelledError):
                    raise
                return
        row = self.store.get_task(key)
        if row["status"] == "delivered":
            try:
                state = await asyncio.to_thread(self.chain.job, spec)
                if state and state["status"] in ("Rejected", "Expired"):
                    self.store.transition(
                        key,
                        "aborted",
                        expected={"delivered"},
                        error="Task refunded before submission",
                    )
                    return
                await asyncio.to_thread(self.chain.submit, spec, commitment(row["data"]["result"]))
                self.store.transition(key, "submitted", expected={"delivered"})
            except Exception:
                pass  # durable result; retry original signed submission only, never runtime

    async def worker(self):
        while True:
            for row in self.store.list_tasks("queued", "delivered")[: self.config.max_pending]:
                await self.execute(row)
            await asyncio.sleep(1)

    def public_terms(self):
        return {
            "chain_id": self.config.chain_id,
            "contract": self.config.contract,
            "token": self.config.token,
            "provider": self.chain.address,
            "tools": self.config.tools,
            "experimental": True,
        }

    async def terms(self, request):
        return JSONResponse(self.public_terms(), headers={"Cache-Control": "no-store"})

    def app(self):
        from mcp.server.fastmcp import FastMCP
        from mcp.server.transport_security import TransportSecuritySettings
        from starlette.routing import Mount

        discovery = FastMCP(
            "envarpay task capabilities",
            stateless_http=True,
            json_response=True,
            transport_security=TransportSecuritySettings(
                allowed_hosts=[
                    *self.config.allowed_hosts,
                    *(host + ":*" for host in self.config.allowed_hosts if ":" not in host),
                ]
            ),
        )

        @discovery.tool()
        def task_terms() -> dict[str, Any]:
            """Read fixed task terms. Does not fund, submit or execute a task."""
            return self.public_terms()

        mcp_app = discovery.streamable_http_app()

        async def proof(request):
            registration = self.config.registration
            if registration and request.path_params["agent_id"] == registration.agent_id:
                return JSONResponse(
                    registration.model_dump(), headers={"Cache-Control": "no-store"}
                )
            return JSONResponse({"error": "Not found"}, status_code=404)

        @asynccontextmanager
        async def lifespan(app):
            with exclusive(self.store.path.parent / "task-server.lock"):
                await self.initialize()
                # One signer owner; bounded runtime concurrency is deliberately one in v1.
                worker = asyncio.create_task(self.worker())
                async with mcp_app.router.lifespan_context(mcp_app):
                    try:
                        yield
                    finally:
                        worker.cancel()
                        await asyncio.gather(worker, return_exceptions=True)

        app = Starlette(
            routes=[
                Route("/terms", self.terms),
                Route("/tasks", self.create, methods=["POST"]),
                Route("/tasks/{job_id}", self.get),
                Route("/.well-known/envar/{agent_id}", proof),
                Mount("/", app=mcp_app),
            ],
            lifespan=lifespan,
        )
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=self.config.allowed_hosts)
        return app
