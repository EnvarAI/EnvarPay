"""Operator-owned task policy. Public-chain signing is Base Sepolia only."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator

from ..config import Backend, StrictModel, address, secure_url

USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"


class TaskPeer(StrictModel):
    url: str
    provider: str
    token_file: str
    tools: dict[str, int] = Field(min_length=1, max_length=64)

    _url = field_validator("url")(secure_url)
    _provider = field_validator("provider")(address)

    @field_validator("tools")
    @classmethod
    def prices(cls, value):
        if any(type(v) is not int or not 1 <= v <= 100000 for v in value.values()):
            raise ValueError("Task prices must be integer USDC atomic units, at most 0.1 USDC")
        return value


class TaskClient(StrictModel):
    address: str
    token_file: str

    _address = field_validator("address")(address)


class TaskConfig(StrictModel):
    mode: Literal["task"] = "task"
    schema_version: Literal[1] = 1
    network: Literal["base-sepolia", "local"] = "base-sepolia"
    rpc_url: str = "https://sepolia.base.org"
    contract: str
    token: str = USDC
    state_dir: str = "./task-state"
    key_file: str
    signing_enabled: bool = False
    evaluator_enabled: bool = False
    max_per_task_atomic: int = Field(default=10000, ge=1, le=100000)
    max_total_atomic: int = Field(default=10000, ge=1, le=1000000)
    max_gas_price_wei: int = Field(default=2000000000, ge=1, le=10000000000)
    max_gas_per_transaction: int = Field(default=1500000, ge=21000, le=3000000)
    confirmations: int = Field(default=2, ge=1, le=100)
    timeout_seconds: int = Field(default=180, ge=5, le=600)
    max_duration_seconds: int = Field(default=86400, ge=60, le=604800)
    max_result_bytes: int = Field(default=1048576, ge=1024, le=10485760)
    peers: dict[str, TaskPeer] = Field(default_factory=dict)
    clients: dict[str, TaskClient] = Field(default_factory=dict)
    backend: Backend | None = None
    tools: dict[str, int] = Field(default_factory=dict)
    workers: Literal[1] = 1
    max_pending: int = Field(default=16, ge=1, le=128)
    host: str = "127.0.0.1"
    port: int = Field(default=4030, ge=1, le=65535)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1"])

    _contract = field_validator("contract")(address)
    _token = field_validator("token")(address)
    _rpc = field_validator("rpc_url")(secure_url)
    _prices = field_validator("tools")(TaskPeer.prices.__func__)

    @model_validator(mode="after")
    def validate_scope(self):
        if self.network == "base-sepolia" and self.token.lower() != USDC.lower():
            raise ValueError("Task mode requires official Base Sepolia USDC")
        if self.network == "local":
            from urllib.parse import urlsplit

            if urlsplit(self.rpc_url).hostname not in ("localhost", "127.0.0.1", "::1"):
                raise ValueError("Local task RPC must use loopback")
        if self.backend and (not self.clients or not self.tools):
            raise ValueError("Task seller needs authenticated clients and fixed prices")
        if self.backend and self.peers:
            raise ValueError("Separate buyer wallet and seller execution configurations")
        return self

    @property
    def chain_id(self):
        return 31337 if self.network == "local" else 84532


def load_task_config(path: Path) -> TaskConfig:
    path = path.expanduser().resolve()
    config = TaskConfig.model_validate(tomllib.loads(path.read_text()))

    def resolve(value):
        p = Path(value).expanduser()
        # Do not resolve symlinks before secret_file verifies them.
        return str(p if p.is_absolute() else path.parent / p)

    for name in ("state_dir", "key_file"):
        setattr(config, name, resolve(getattr(config, name)))
    for entry in [*config.peers.values(), *config.clients.values()]:
        entry.token_file = resolve(entry.token_file)
    if config.backend and config.backend.api_key_file:
        config.backend.api_key_file = resolve(config.backend.api_key_file)
    return config
