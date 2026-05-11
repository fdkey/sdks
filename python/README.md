# fdkey

> **FDKEY verification middleware for MCP servers (Python).** Gate AI-agent
> access to your tools behind LLM-only puzzles. Drop-in for any
> [Model Context Protocol](https://modelcontextprotocol.io) server built
> on the official Python SDK's `FastMCP`.

## What it does

- Injects two MCP tools into your server: `fdkey_get_challenge` and
  `fdkey_submit_challenge`, with stable MCP tool annotations
  (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) for client trust hints. Annotations degrade
  gracefully on older `mcp` package versions that lack the keyword.
- Wraps the tools you want to protect — they return
  `fdkey_verification_required` until the connecting agent has solved a
  challenge.
- Talks to `https://api.fdkey.com` for challenge issuance and scoring.
- Verifies the Ed25519 JWT response **offline** using the public key
  from `https://api.fdkey.com/.well-known/fdkey.json`.

**The SDK is puzzle-agnostic.** All agent-facing prose (puzzle text,
per-type instructions, wire-format examples, timing framing) is rendered
server-side by the VPS and passed through verbatim as the
`fdkey_get_challenge` tool result (via the VPS's `mcp_response_text`
field). Adding a new puzzle type or changing an answer format is a
VPS-only concern — no SDK release needed.

## Install

```bash
pip install fdkey
```

You also need the official MCP Python SDK:

```bash
pip install mcp
```

Get an API key at [app.fdkey.com](https://app.fdkey.com).

## Usage

```python
import os
from mcp.server.fastmcp import FastMCP
from fdkey import with_fdkey

server = FastMCP("my-server")

with_fdkey(
    server,
    api_key=os.environ["FDKEY_API_KEY"],
    protect={
        "sensitive_action": {"policy": "each_call"},
        "register": {"policy": "once_per_session"},
    },
)

@server.tool()
def sensitive_action() -> str:
    # Reaches here only after the agent has solved a challenge.
    return "verified"
```

## Policies

Per-tool gating policy — passed as `{"policy": ...}` in the `protect` map:

- `"each_call"` — verification required for every invocation. Use for
  irreversible actions (payments, deletes).
- `"once_per_session"` — verification required once per connection. Use
  for account creation, signup-style flows.
- `{"type": "every_minutes", "minutes": N}` — verification good for N
  minutes after the puzzle was solved. Middle ground when "every call"
  is too aggressive but "once forever" is too loose. The timer does NOT
  extend on calls — it expires `minutes` after the solve, regardless
  of activity.

```python
protect={
    "delete_account":    {"policy": "each_call"},
    "register":          {"policy": "once_per_session"},
    "refresh_dashboard": {"policy": {"type": "every_minutes", "minutes": 15}},
}
```

## Configuration reference

```python
with_fdkey(
    server,
    api_key="fdk_...",          # required
    protect={...},               # tool name -> {"policy": ...}
    vps_url="https://api.fdkey.com",  # override for self-hosted
    difficulty="medium",         # easy | medium | hard
    on_fail="block",             # block | allow (puzzle failed)
    on_vps_error="allow",        # block | allow — see below
    inline_challenge=False,      # embed puzzle in blocked-tool error
    tags={"env": "prod"},        # forwarded to FDKEY for analytics
)
```

### Failure-mode defaults

`on_vps_error="allow"` is the default — if the FDKEY scoring service is
unreachable, the protected tool falls through to your handler instead of
blocking. We chose this so an FDKEY outage doesn't brick your workflow
(e.g. if we shut down or DNS can't resolve `api.fdkey.com`). FDKEY is
verification, not gating — your service should still serve traffic when
ours is down. Set `on_vps_error="block"` if you'd rather drop traffic
than admit unverified callers during an outage.

## Reading verification context

```python
from fdkey import get_fdkey_context

@server.tool()
def whoami(ctx) -> str:
    fdkey = get_fdkey_context(server, ctx)
    if fdkey and fdkey.verified:
        # `score` and `tier` are first-class fields on the context.
        # `score` is a 0..1 float — today effectively binary
        # (1.0 passed / 0.0 failed) but reserved for future capability
        # scoring without an API change. `tier` is the VPS-issued
        # capability bucket label.
        return f"verified (score={fdkey.score}, tier={fdkey.tier})"
    return "not verified"
```

## What FDKEY sees

- The MCP `clientInfo` your agent reports (when forwarded by your server).
- Challenge IDs, scores, timestamps.
- Your integrator-supplied `tags`.

## Security notes

- **JWT `aud` is not validated by the SDK.** The audience claim binds the
  JWT to the integrator's `vps_users.id`, which the SDK doesn't know at
  verify time. The VPS already binds `aud` to the API key that requested
  the challenge — defense in depth — but in principle, a JWT issued for
  one FDKEY-protected service could be replayed against a different one
  within the JWT lifetime (~5 min default). Keep the JWT lifetime short
  on the VPS side if your threat model includes cross-integrator replay.

## What FDKEY does NOT see

- Your prompts.
- Tool inputs or outputs.
- Your end users' identities or PII.

## Links

- Marketing + docs: <https://fdkey.com>
- Dashboard (sign up + manage keys): <https://app.fdkey.com>
- Source: <https://github.com/fdkey/sdks>
- Issues: <https://github.com/fdkey/sdks/issues>

## License

MIT — see [LICENSE](./LICENSE).
