"""Apply explicitly opted-in seller prices; never touch a buyer wallet or runtime settings."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import tomli_w

from .config import Receiving, load_config
from .storage import PaymentError, digest


async def apply_receiving(server, config_path):
    connection = server.config.connection
    if not connection or not connection.accept_receiving_updates or not config_path:
        return False
    response = await server.envar.request(
        "GET", f"/api/v1/agents/{connection.agent_id}/receiving/config"
    )
    if not response.get("config"):
        return False
    desired = Receiving.model_validate(response["config"])
    fingerprint = digest(desired.model_dump(mode="json"))
    if response.get("digest") != fingerprint:
        raise PaymentError("Receiving configuration digest does not match")
    if desired.network != server.config.network:
        raise PaymentError("Select the same network locally before applying receiving settings")
    if fingerprint != server.applied_digest:
        path = Path(config_path)
        if path.is_symlink():
            raise PaymentError("Receiving configuration cannot be a symlink")
        config = load_config(path)
        if not config.connection or not config.connection.accept_receiving_updates:
            return False
        if (
            config.connection.agent_id != connection.agent_id
            or config.connection.platform_url != connection.platform_url
        ):
            raise PaymentError("Local Envar connection changed; restart the service")
        if not config.seller or config.wallet or config.network != desired.network:
            raise PaymentError("Receiving updates require a separate seller configuration")
        config.seller.pay_to, config.seller.tools = desired.pay_to, desired.tools
        from .seller import PaidServer

        candidate = PaidServer(config)
        await candidate.initialize()
        fd, temporary = tempfile.mkstemp(prefix=".receiving-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                tomli_w.dump(config.model_dump(mode="json", exclude_none=True), output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        # Existing in-flight calls retain their prior object and immutable quote.
        server.current, server.applied_digest = candidate, fingerprint
    await server.envar.request(
        "POST",
        f"/api/v1/agents/{connection.agent_id}/receiving/applied",
        body={"revision": response["revision"], "digest": fingerprint},
    )
    return True
