"""Strict operator-owned configuration; no private keys in config values."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from eth_utils import is_address, to_checksum_address
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NETWORKS = {
    "eip155:84532": (84532, "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    "eip155:8453": (8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
}


def address(value: str) -> str:
    if not is_address(value) or int(value, 16) == 0:
        raise ValueError("A nonzero EVM address is required")
    return to_checksum_address(value)


def web_url(value: str, allow_http: bool = False) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Expected an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError("URLs must not contain credentials, queries or fragments")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        if not allow_http:
            raise ValueError("Remote HTTP needs allow_http=true; use HTTPS outside local networks")
    return value.rstrip("/")


def secure_url(value: str) -> str:
    return web_url(value)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Endpoint(StrictModel):
    transport: Literal["streamable-http", "sse", "stdio"] = "streamable-http"
    url: str | None = None
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: list[str] = Field(default_factory=list)
    bearer_token_env: str | None = None
    allow_http: bool = False

    @model_validator(mode="after")
    def valid_endpoint(self) -> Endpoint:
        if self.transport == "stdio":
            if not self.command or self.url or self.bearer_token_env:
                raise ValueError("stdio requires command and forbids URL/bearer token")
        else:
            if not self.url or self.command or self.args or self.env:
                raise ValueError("HTTP transports require URL and forbid command/args/env")
            self.url = web_url(self.url, self.allow_http)
        return self


class Backend(StrictModel):
    kind: Literal["mcp", "http"]
    upstream: Endpoint | None = None
    model: str = ""
    base_url: str | None = None
    http_api: Literal["responses", "chat-completions"] = "responses"
    allow_http: bool = False
    max_response_bytes: int = Field(default=1048576, ge=1024, le=10485760)
    api_key_env: str | None = None
    api_key_file: str | None = None

    @model_validator(mode="after")
    def valid_backend(self) -> Backend:
        if self.kind == "mcp" and self.upstream is None:
            raise ValueError("MCP backend requires upstream")
        if self.kind == "http":
            if not self.model or self.model == "YOUR_MODEL" or self.upstream is not None:
                raise ValueError("HTTP backend requires a fixed model/agent target and no upstream")
            if not self.base_url:
                raise ValueError("HTTP backend requires the existing agent's /v1 base_url")
            self.base_url = web_url(self.base_url, self.allow_http)
            if not self.base_url.endswith("/v1"):
                raise ValueError("HTTP base_url must end with /v1")
            if not (self.api_key_env or self.api_key_file):
                raise ValueError("HTTP backend requires a server-owned credential reference")
        if self.api_key_env and self.api_key_file:
            raise ValueError("Choose api_key_env or api_key_file")
        return self


class Price(StrictModel):
    amount_atomic: int = Field(ge=1, le=10**12)


class Receiving(StrictModel):
    network: Literal["eip155:84532", "eip155:8453"]
    pay_to: str
    tools: dict[str, Price] = Field(min_length=1, max_length=64)

    _pay_to = field_validator("pay_to")(address)


class Registration(StrictModel):
    agent_id: str
    challenge: str = Field(min_length=20, max_length=64)

    @field_validator("agent_id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return str(UUID(value))


class Service(StrictModel):
    """An authenticated entry to an existing private Agent, without a receiving wallet."""

    host: str = "127.0.0.1"
    port: int = Field(default=4020, ge=1, le=65535)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost:*", "127.0.0.1:*"])
    bearer_token_file: str
    backend: Backend
    tools: list[str] = Field(min_length=1, max_length=64)


class Seller(StrictModel):
    pay_to: str
    facilitator_url: str = "https://x402.org/facilitator"
    host: str = "127.0.0.1"
    port: int = Field(default=4020, ge=1, le=65535)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost:*", "127.0.0.1:*"])
    backend: Backend
    tools: dict[str, Price] = Field(min_length=1)

    _pay_to = field_validator("pay_to")(address)
    _facilitator = field_validator("facilitator_url")(secure_url)


class Peer(Endpoint):
    agent_id: str | None = None
    endpoint_id: str | None = None
    recovery: bool = False
    pay_to: str
    tools: list[str] = Field(min_length=1)

    _pay_to = field_validator("pay_to")(address)


class Wallet(StrictModel):
    key_file: str
    payments_enabled: bool = False
    max_per_call_atomic: int = Field(default=10000, ge=1, le=10**12)
    max_total_atomic: int = Field(default=10000, ge=1, le=10**12)
    peers: dict[str, Peer] = Field(min_length=1)


class Connection(StrictModel):
    accept_receiving_updates: bool = False
    platform_url: str = "https://envar.ai"
    agent_id: str
    token_file: str

    _url = field_validator("platform_url")(secure_url)

    @field_validator("agent_id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return str(UUID(value))


class WalletServer(StrictModel):
    host: str = "127.0.0.1"
    port: int = Field(default=4021, ge=1, le=65535)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost:*", "127.0.0.1:*"])
    bearer_token_file: str


class Config(StrictModel):
    schema_version: Literal[1] = 1
    network: Literal["eip155:84532", "eip155:8453"] = "eip155:84532"
    rpc_url: str = "https://sepolia.base.org"
    state_dir: str = "./state"
    confirmations: int = Field(default=2, ge=1, le=100)
    timeout_seconds: int = Field(default=180, ge=5, le=600)
    seller: Seller | None = None
    wallet: Wallet | None = None
    service: Service | None = None
    registration: Registration | None = None
    connection: Connection | None = None
    wallet_server: WalletServer | None = None

    _rpc = field_validator("rpc_url")(secure_url)

    @model_validator(mode="after")
    def role_required(self) -> Config:
        if self.seller is None and self.wallet is None and self.service is None:
            raise ValueError("Configure an existing service, seller or wallet")
        if self.wallet_server and (not self.wallet or self.seller or self.service):
            raise ValueError("Run the wallet server separately from the Agent or seller")
        if self.seller is not None and self.service is not None:
            raise ValueError("Use separate private and public paid service configurations")
        return self

    @property
    def chain_id(self) -> int:
        return NETWORKS[self.network][0]

    @property
    def asset(self) -> str:
        return NETWORKS[self.network][1]

    @property
    def token_name(self) -> str:
        return "USD Coin" if self.network == "eip155:8453" else "USDC"


def load_config(path: Path) -> Config:
    path = path.expanduser().resolve()
    config = Config.model_validate(tomllib.loads(path.read_text()))

    def resolve(value: str) -> str:
        candidate = Path(value).expanduser()
        return str(
            candidate.resolve() if candidate.is_absolute() else (path.parent / candidate).resolve()
        )

    config.state_dir = resolve(config.state_dir)
    if config.connection:
        config.connection.token_file = resolve(config.connection.token_file)
    if config.wallet_server:
        config.wallet_server.bearer_token_file = resolve(config.wallet_server.bearer_token_file)
    if config.wallet:
        config.wallet.key_file = resolve(config.wallet.key_file)
    if config.seller and config.seller.backend.api_key_file:
        config.seller.backend.api_key_file = resolve(config.seller.backend.api_key_file)
    if config.service:
        config.service.bearer_token_file = resolve(config.service.bearer_token_file)
        if config.service.backend.api_key_file:
            config.service.backend.api_key_file = resolve(config.service.backend.api_key_file)
    return config
