"""Frozen terms shared by HTTP, Python and MCP task clients."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from eth_utils import keccak
from pydantic import Field, field_validator

from ..config import StrictModel, address


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False
    ).encode()


def commitment(value: Any) -> bytes:
    return keccak(canonical(value))


class TaskSpec(StrictModel):
    version: Literal[1] = 1
    request_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    chain_id: Literal[84532, 31337]
    contract: str
    token: str
    client: str
    provider: str
    evaluator: str
    amount_atomic: int = Field(ge=1, le=100000)
    deadline: int = Field(gt=0)
    tool: str = Field(min_length=1, max_length=100)
    arguments: dict[str, Any]
    acceptance: str = Field(min_length=1, max_length=4000)

    _addresses = field_validator("contract", "token", "client", "provider", "evaluator")(address)

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value):
        if len(canonical(value)) > 65536:
            raise ValueError("Task arguments exceed 64 KiB")
        return value

    @property
    def job_id(self):
        # ID is bound to buyer and stable request ID, not mutable task arguments.
        return keccak(canonical([self.chain_id, self.contract, self.client, self.request_id]))

    @property
    def terms_hash(self):
        return commitment(self.model_dump())

    @property
    def binding(self):
        return hashlib.sha256(canonical(self.model_dump())).hexdigest()
