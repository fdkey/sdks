/**
 * Session-id extraction + minting. Three strategies:
 *
 *   - 'cookie' (default): read/write a `fdkey_session=<uuid>` cookie.
 *     Framework-agnostic — we read the raw `Cookie` request header and
 *     write `Set-Cookie` ourselves. No `cookie-parser` dep needed.
 *
 *   - 'header': read `X-FDKEY-Session: <id>`. Caller-supplied id; the
 *     SDK never mints one. Useful for headless clients that opt into
 *     session tracking via a custom header.
 *
 *   - { extract, attach? }: integrator-defined. SDK calls `extract` to
 *     find the id on the request and `attach` (if present) to surface a
 *     freshly-minted id on the response.
 */

import type { HeadersInput, SessionStrategy } from './types.js';

export const DEFAULT_COOKIE_NAME = 'fdkey_session';
export const DEFAULT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 h

/** Pull a single header value out of either a plain headers object or a
 *  Web Headers instance. Case-insensitive. */
function getHeader(headers: HeadersInput, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const h = headers as Record<string, string | string[] | undefined>;
  // Express lowercases incoming headers; Fastify follows the same convention.
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Read the value of a cookie out of a `Cookie:` header line. */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(';')) {
    const trimmed = segment.trim();
    if (trimmed.startsWith(name + '=')) {
      return trimmed.slice(name.length + 1) || null;
    }
  }
  return null;
}

/** Validate a cookie NAME — must not smuggle CRLF / `;` / `,` / `=` /
 *  whitespace, any of which would terminate the name token early or
 *  inject another `Set-Cookie` header. RFC 6265 § 4.1.1 token grammar. */
function assertSafeCookieName(raw: string): void {
  if (raw.length === 0 || /[;\r\n,\s=]/.test(raw)) {
    throw new Error(
      "@fdkey/http: invalid cookie name (CRLF / ';' / ',' / '=' / whitespace not allowed)",
    );
  }
}

/** Validate a cookie VALUE — RFC 6265 cookie-octet excludes CTL chars,
 *  whitespace, `,`, `;`, `\`, and DQUOTE, but DOES allow `=`. So a
 *  base64-encoded session id with `=` padding is fine; what we still
 *  reject is anything that could break out of the cookie-value position
 *  and inject another header. */
function assertSafeCookieValue(raw: string): void {
  if (/[;\r\n,\s"\\]/.test(raw)) {
    throw new Error(
      "@fdkey/http: invalid cookie value (CRLF / ';' / ',' / '\"' / '\\' / whitespace not allowed)",
    );
  }
}

/** Build the `Set-Cookie` value the SDK uses to persist the session id.
 *  HttpOnly + SameSite=Lax + Secure (HTTPS-only) are deliberate choices —
 *  see the README "deploy over HTTPS" warning. */
export function buildSetCookieValue(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  assertSafeCookieName(name);
  assertSafeCookieValue(value);
  return (
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

/** Result of session-id resolution. The caller branches on these:
 *
 *  - `kind: 'existing'` — request carried a session id; use it.
 *  - `kind: 'minted'` — request didn't carry one but the strategy
 *    supports minting (cookie, custom-with-attach). Caller must surface
 *    the new id to the response so subsequent requests find the session.
 *  - `kind: 'missing'` — request didn't carry one AND the strategy
 *    can't mint a usable one (header strategy with no header). Caller
 *    must return HTTP 400 with a hint — minting silently here would
 *    create an infinite loop because the agent has no way to learn the
 *    minted id (header strategy provides no response surface for it).
 */
export type SessionIdResolution =
  | { kind: 'existing'; sid: string }
  | { kind: 'minted'; sid: string }
  | { kind: 'missing' };

export function resolveSessionId(
  strategy: SessionStrategy,
  cookieName: string,
  headers: HeadersInput,
  mintNew: () => string,
): SessionIdResolution {
  if (strategy === 'cookie') {
    const cookie = getHeader(headers, 'cookie');
    const existing = readCookie(cookie, cookieName);
    if (existing) return { kind: 'existing', sid: existing };
    return { kind: 'minted', sid: mintNew() };
  }
  if (strategy === 'header') {
    const v = getHeader(headers, 'x-fdkey-session');
    if (v) return { kind: 'existing', sid: v };
    // Header strategy can't mint usefully — there's no response surface
    // to tell the agent which sid we picked. Caller must 400.
    return { kind: 'missing' };
  }
  // Custom strategy.
  const extracted = strategy.extract(headers);
  if (extracted) return { kind: 'existing', sid: extracted };
  // Custom strategy mints only if it provided an `attach` callback —
  // otherwise we'd hit the same infinite-loop problem.
  if (typeof strategy.attach === 'function') {
    return { kind: 'minted', sid: mintNew() };
  }
  return { kind: 'missing' };
}

/** Generate a fresh session id. Prefers `crypto.randomUUID()` (Node 19+,
 *  Workers, Bun, Deno, all modern browsers). Falls back to 32 hex chars
 *  via `crypto.getRandomValues`. **Throws** if neither is available —
 *  silently using `Math.random()` here would mean predictable session
 *  ids, which would let an attacker hijack any verified session. Failing
 *  loud on an exotic runtime is the only safe choice. */
export function mintSessionId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (typeof c?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  throw new Error(
    '@fdkey/http: cryptographic RNG unavailable on this runtime. ' +
      'Web Crypto (`crypto.randomUUID` or `crypto.getRandomValues`) is ' +
      'required — session ids must be unguessable. If you are running ' +
      'on a stripped-down environment without Web Crypto, polyfill it ' +
      'before importing @fdkey/http.',
  );
}

export { getHeader, readCookie };
