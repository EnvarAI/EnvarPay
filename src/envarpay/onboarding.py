"""Atomic local registration setup. Never changes signing policy or wallet budgets."""

from __future__ import annotations

import os
import tempfile
import tomllib
from pathlib import Path

import tomli_w

from .config import Config, Connection, Registration
from .storage import PaymentError, secret_file


def connect_config(
    path: Path,
    agent_id: str,
    challenge: str,
    *,
    token_file: Path | None = None,
    platform_url: str = "https://envar.ai",
    receiving: bool = False,
    task: bool = False,
):
    if path.is_symlink() or not path.is_file():
        raise PaymentError("Select an existing regular configuration file")
    path = path.expanduser().absolute()
    data = tomllib.loads(path.read_text())
    proof = Registration(agent_id=agent_id, challenge=challenge)
    data["registration"] = proof.model_dump()
    if task:
        from .tasks.config import TaskConfig

        if token_file or receiving:
            raise PaymentError(
                "Task wallets use their private wallet credential, not receiving synchronization"
            )
        TaskConfig.model_validate(data)
    else:
        if token_file:
            credential = secret_file(token_file.expanduser().absolute())
            if not credential.startswith("envar_agent_"):
                raise PaymentError("Use the Agent-scoped Envar connection credential file")
            connection = Connection(
                agent_id=agent_id,
                token_file=str(token_file.expanduser().absolute()),
                platform_url=platform_url,
                accept_receiving_updates=receiving,
            )
            data["connection"] = connection.model_dump()
        elif receiving:
            raise PaymentError("Receiving synchronization requires the bound Agent credential file")
        if data.get("connection", {}).get("agent_id", agent_id) != agent_id:
            raise PaymentError(
                "Existing connection belongs to a different Agent; "
                "supply its new credential explicitly"
            )
        cfg = Config.model_validate(data)
        if receiving and (not cfg.seller or cfg.wallet or cfg.service):
            raise PaymentError("Receiving synchronization requires a separate seller configuration")
    fd, temporary = tempfile.mkstemp(prefix=".connect-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            tomli_w.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {
        "configured": True,
        "agent_id": agent_id,
        "restart_required": True,
        "receiving_sync": receiving,
        "signing_policy_changed": False,
    }


def approve_peer(
    path: Path,
    name: str,
    url: str,
    pay_to: str,
    tool: str,
    agent_id: str,
    endpoint_id: str,
    recovery: bool = False,
    task: bool = False,
    amount_atomic: int | None = None,
    token_file: Path | None = None,
):
    import re
    from uuid import UUID

    from .config import Peer

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) or not re.fullmatch(
        r"[A-Za-z0-9_.-]{1,128}", tool
    ):
        raise PaymentError("Use a bounded peer alias and exact tool name")
    if path.is_symlink() or not path.is_file():
        raise PaymentError("Select an existing regular wallet configuration")
    data = tomllib.loads(path.read_text())
    if task:
        from .tasks.config import TaskConfig, TaskPeer

        original = TaskConfig.model_validate(data)
        if original.backend or not token_file or amount_atomic is None:
            raise PaymentError(
                "Task approval needs a buyer wallet, scoped provider token and exact price"
            )
        credential = secret_file(token_file.expanduser().absolute())
        if len(credential) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in credential):
            raise PaymentError("Use the provider-approved buyer credential file")
        peer = TaskPeer(
            url=url,
            provider=pay_to,
            token_file=str(token_file.expanduser().absolute()),
            tools={tool: amount_atomic},
            agent_id=str(UUID(agent_id)),
            endpoint_id=str(UUID(endpoint_id)),
        )
        current = original.peers.get(name)
        if current and current.model_dump() != peer.model_dump():
            raise PaymentError("This alias already has different terms; choose a new alias")
        data.setdefault("peers", {})[name] = peer.model_dump(mode="json", exclude_none=True)
        TaskConfig.model_validate(data)
        enabled = original.signing_enabled
    else:
        original = Config.model_validate(data)
        if not original.wallet or original.seller or original.service:
            raise PaymentError("Select a separate buyer wallet")
        peer = Peer(
            url=url,
            pay_to=pay_to,
            tools=[tool],
            agent_id=str(UUID(agent_id)),
            endpoint_id=str(UUID(endpoint_id)),
            recovery=recovery,
        )
        current = original.wallet.peers.get(name)
        if current and current.model_dump() != peer.model_dump():
            raise PaymentError("This alias already has different terms; choose a new alias")
        data["wallet"]["peers"][name] = peer.model_dump(mode="json", exclude_none=True)
        Config.model_validate(data)
        enabled = original.wallet.payments_enabled
    fd, temporary = tempfile.mkstemp(prefix=".peer-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            tomli_w.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {
        "approved_peer": name,
        "restart_required": True,
        "budgets_changed": False,
        "signing_enabled": enabled,
    }
