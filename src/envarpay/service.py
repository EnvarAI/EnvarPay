"""MCP transport and authenticated access to an existing private Agent."""

from __future__ import annotations

import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from jsonschema.validators import validator_for
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent
from referencing import Registry
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route

from .backend import AgentBackend
from .storage import PaymentError, secret_file


def service_app(server, initialize, *, allowed_hosts, registration=None, bearer=""):
    security = TransportSecuritySettings(allowed_hosts=allowed_hosts)
    manager = StreamableHTTPSessionManager(
        server, stateless=True, json_response=True, security_settings=security
    )
    sse = SseServerTransport("/messages/", security_settings=security)

    @asynccontextmanager
    async def lifespan(app):
        await initialize()
        async with manager.run():
            yield

    async def proof(request):
        if registration and request.path_params["agent_id"] == registration.agent_id:
            return JSONResponse(registration.model_dump(), headers={"Cache-Control": "no-store"})
        return Response(status_code=404)

    async def events(request):
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(*streams, server.create_initialization_options())
        return Response()

    class MCP:
        async def __call__(self, scope, receive, send):
            await manager.handle_request(scope, receive, send)

    app = Starlette(
        lifespan=lifespan,
        routes=[
            Route("/.well-known/envar/{agent_id}", proof),
            Route("/mcp", MCP()),
            Route("/sse", events),
            Mount("/messages/", app=sse.handle_post_message),
        ],
    )
    return authenticated_app(app, bearer)


def authenticated_app(app, bearer):
    if not bearer:
        return app

    class AuthenticatedService:
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and not scope["path"].startswith("/.well-known/envar/"):
                header = dict(scope.get("headers", [])).get(b"authorization", b"")
                if not secrets.compare_digest(header, f"Bearer {bearer}".encode()):
                    response = JSONResponse(
                        {"error": "Service authentication required"},
                        status_code=401,
                        headers={"WWW-Authenticate": "Bearer"},
                    )
                    await response(scope, receive, send)
                    return
            await app(scope, receive, send)

    return AuthenticatedService()


class AgentService:
    def __init__(self, config):
        if not config.service:
            raise PaymentError("Configure [service] to expose your existing private Agent")
        self.config, self.policy = config, config.service
        self.bearer = secret_file(Path(self.policy.bearer_token_file))
        if len(self.bearer) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in self.bearer):
            raise PaymentError(
                "Service token must contain at least 32 printable non-space characters"
            )
        self.backend = AgentBackend(self.policy.backend, config.timeout_seconds)
        self.server = Server("envarpay connected agent")
        self.tools = {}

        @self.server.list_tools()
        async def listing():
            return list(self.tools.values())

        @self.server.call_tool()
        async def calling(name, arguments):
            if name not in self.tools:
                return CallToolResult(
                    content=[TextContent(type="text", text="Unknown capability")], isError=True
                )
            try:
                validator_for(self.tools[name].inputSchema)(
                    self.tools[name].inputSchema, registry=Registry()
                ).validate(arguments)
                return await self.backend.call(name, arguments)
            except Exception:
                return CallToolResult(
                    content=[
                        TextContent(
                            type="text",
                            text="Result unresolved; inspect the original task before retrying",
                        )
                    ],
                    isError=True,
                )

    async def initialize(self):
        available = {tool.name: tool for tool in await self.backend.list_tools()}
        if not set(self.policy.tools) <= available.keys():
            raise PaymentError("A selected capability is missing from the existing service")
        self.tools = {name: available[name] for name in self.policy.tools}

    def app(self):
        return service_app(
            self.server,
            self.initialize,
            allowed_hosts=self.policy.allowed_hosts,
            registration=self.config.registration,
            bearer=self.bearer,
        )
