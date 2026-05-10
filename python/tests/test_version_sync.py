"""SDK_VERSION must match in three places: pyproject.toml's project.version,
src/fdkey/__init__.py's __version__, and src/fdkey/middleware.py's
SDK_VERSION constant. The constant is forwarded to the VPS as
integrator.sdk_version on every challenge — a drift here means analytics
reports a release that doesn't match the wheel on PyPI."""

from __future__ import annotations

import re
from pathlib import Path

try:
    import tomllib as toml_lib  # py 3.11+
except ImportError:  # pragma: no cover
    import tomli as toml_lib  # type: ignore[import-not-found]


REPO_ROOT = Path(__file__).resolve().parent.parent


def _read_pyproject_version() -> str:
    data = toml_lib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def _read_init_version() -> str:
    text = (REPO_ROOT / "src" / "fdkey" / "__init__.py").read_text(encoding="utf-8")
    match = re.search(r"^__version__\s*=\s*['\"]([^'\"]+)['\"]", text, re.MULTILINE)
    assert match, "could not find __version__ in __init__.py"
    return match.group(1)


def _read_middleware_constant() -> str:
    text = (REPO_ROOT / "src" / "fdkey" / "middleware.py").read_text(encoding="utf-8")
    match = re.search(r"^SDK_VERSION\s*=\s*['\"]([^'\"]+)['\"]", text, re.MULTILINE)
    assert match, "could not find SDK_VERSION in middleware.py"
    return match.group(1)


def test_pyproject_and_init_match():
    assert _read_init_version() == _read_pyproject_version()


def test_init_and_middleware_constant_match():
    assert _read_middleware_constant() == _read_init_version()
