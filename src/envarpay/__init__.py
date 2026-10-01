"""Standard-protocol payment adapters and read-only configuration/receipt utilities."""

__version__ = "0.1.0a7"

from .config import Config, load_config

__all__ = ["Config", "PaidServer", "WalletService", "load_config", "__version__"]


def __getattr__(name):
    # Reading configuration or receipts does not load signer/runtime dependencies.
    if name == "PaidServer":
        from .seller import PaidServer

        return PaidServer
    if name == "WalletService":
        from .wallet import WalletService

        return WalletService
    raise AttributeError(name)
