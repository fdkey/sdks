"""FDKEY — verification middleware for MCP servers.

Public API:

    from fdkey import with_fdkey, get_fdkey_context, FdkeyContext
"""

from .middleware import get_fdkey_context, with_fdkey
from .types import FdkeyConfig, FdkeyContext, Policy

__version__ = "0.1.1"

__all__ = [
    "with_fdkey",
    "get_fdkey_context",
    "FdkeyContext",
    "FdkeyConfig",
    "Policy",
    "__version__",
]
