// FDKEY browser widget — drop-in puzzle challenge UI.
//
// Integrator usage (full example):
//
//   <div id="fdkey-demo"></div>
//   <script type="module">
//     import { fdkeyChallenge } from '@fdkey/http/client';
//     const verdict = await fdkeyChallenge(
//       document.getElementById('fdkey-demo'),
//       { endpoint: '/api/fdkey' }
//     );
//     // verdict: { verified, score?, tier? }
//   </script>
//
// The widget is data-driven via `renderers.ts`. If the VPS ships a new
// puzzle type whose JSON shape matches an existing pattern (questions,
// concept+options, or prompt), it renders automatically. Unknown shapes
// fall back to JSON-dump + textarea so the agent can still read it.

import { DEFAULT_CSS } from './css.js';
import { pickRenderer } from './renderers.js';
import type {
  ChallengeResponse,
  FdkeyChallengeOptions,
  SubmitResponse,
  Verdict,
} from './types.js';

export type { ChallengeResponse, SubmitResponse, Verdict, FdkeyChallengeOptions };
export { DEFAULT_CSS };

const STYLE_INJECTED = Symbol.for('fdkey-styles-injected');

/** Drop-in puzzle challenge widget. Renders the FDKEY challenge inside
 *  `container`, accepts user input (an LLM agent or a human), submits
 *  to the integrator's mounted SDK routes, and resolves with the
 *  verdict. */
export async function fdkeyChallenge(
  container: HTMLElement,
  opts: FdkeyChallengeOptions = {}
): Promise<Verdict> {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error(
      'fdkeyChallenge: container must be an HTMLElement. ' +
      'Did the element exist when you called this?'
    );
  }
  const endpoint = (opts.endpoint ?? '/fdkey').replace(/\/+$/, '');
  const useDefaultStyles = opts.defaultStyles !== false;

  if (useDefaultStyles) injectDefaultStyles();

  container.innerHTML = '';
  container.classList.add('fdkey-host');

  // Default behavior on the human-facing path: render a Start button so
  // the visitor sees the widget before the timer ticks. Agents that
  // automate the page will see the button too, but reading the page is
  // their normal mode anyway — they can click it. Override with
  // `requireStart: false` for fully-autonomous flows.
  const requireStart = opts.requireStart !== false;

  if (requireStart) {
    const intro = document.createElement('div');
    intro.className = 'fdkey-intro';
    const startBtn = document.createElement('button');
    startBtn.className = 'fdkey-submit';
    startBtn.textContent = 'Start FDKEY challenge';
    startBtn.type = 'button';
    const hint = document.createElement('p');
    hint.className = 'fdkey-instructions';
    hint.style.marginTop = '0.75rem';
    hint.textContent =
      'Fresh puzzles from api.fdkey.com. Solve, submit, get a real ' +
      'capability score back.';
    intro.appendChild(startBtn);
    intro.appendChild(hint);
    container.appendChild(intro);
    await new Promise<void>((resolve) => {
      startBtn.addEventListener('click', () => resolve(), { once: true });
    });
    container.innerHTML = '';
  }

  const root = document.createElement('section');
  root.className = 'fdkey-challenge';
  container.appendChild(root);

  // ── Fetch challenge ──────────────────────────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'fdkey-meta';
  meta.innerHTML = `<span>FDKEY</span><span class="fdkey-timer" data-warning="false">…</span>`;
  root.appendChild(meta);

  let challenge: ChallengeResponse;
  try {
    const res = await fetch(`${endpoint}/challenge`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ''}`);
    }
    challenge = (await res.json()) as ChallengeResponse;
  } catch (err) {
    return renderUnreachable(root, err, opts, container);
  }

  root.dataset.challengeId = challenge.challenge_id;

  // Submit URL — VPS tells us where. Lets the SDK be mounted at any path.
  const submitUrl = challenge.submit_url || `${endpoint}/submit`;

  // ── Render puzzles ───────────────────────────────────────────────────────
  const puzzles = challenge.puzzles ?? {};
  const typesServed = challenge.types_served ?? Object.keys(puzzles);
  for (const typeKey of typesServed) {
    const puzzleData = puzzles[typeKey];
    if (puzzleData == null) continue;
    const renderer = pickRenderer(puzzleData);
    const section = document.createElement('section');
    section.className = 'fdkey-puzzle-group';
    section.dataset.type = typeKey;
    renderer.render(typeKey, puzzleData, section);
    root.appendChild(section);
  }

  // ── Submit button + actions ──────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'fdkey-actions';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'fdkey-submit';
  submitBtn.type = 'button';
  submitBtn.textContent = 'Submit';
  actions.appendChild(submitBtn);
  root.appendChild(actions);

  // ── Raw response — collapsible for debugging ─────────────────────────────
  const rawDetails = document.createElement('details');
  rawDetails.className = 'fdkey-raw';
  rawDetails.innerHTML = `<summary>Raw challenge response (debug)</summary>`;
  const rawPre = document.createElement('pre');
  rawPre.textContent = JSON.stringify(challenge, null, 2);
  rawDetails.appendChild(rawPre);
  root.appendChild(rawDetails);

  // ── Timer ────────────────────────────────────────────────────────────────
  const timerEl = meta.querySelector<HTMLElement>('.fdkey-timer')!;
  const totalSeconds = challenge.expires_in_seconds ?? estimateExpirySeconds(challenge);
  const submission = waitForSubmission(submitBtn, timerEl, totalSeconds);

  // ── Wait for submission (button click or timeout) ────────────────────────
  await submission;
  submitBtn.disabled = true;

  // ── Build wire body ──────────────────────────────────────────────────────
  const answers: Record<string, unknown> = {};
  root.querySelectorAll<HTMLElement>('.fdkey-puzzle-group').forEach((section) => {
    const typeKey = section.dataset.type;
    if (!typeKey) return;
    const puzzleData = puzzles[typeKey];
    if (puzzleData == null) return;
    const renderer = pickRenderer(puzzleData);
    answers[typeKey] = renderer.extract(typeKey, section);
  });

  // ── Submit ───────────────────────────────────────────────────────────────
  let body: SubmitResponse;
  try {
    const res = await fetch(submitUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ challenge_id: challenge.challenge_id, answers }),
    });
    body = (await res.json().catch(() => ({ verified: false }))) as SubmitResponse;
    if (!res.ok && !('verified' in body)) {
      // VPS/SDK returned a non-2xx without a usable body — treat as
      // unreachable. The narrowed SDK fail-open semantic in 0.1.2 means
      // 4xx/5xx come through here unfiltered.
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (err) {
    return renderUnreachable(root, err, opts, container);
  }

  // ── Render verdict ───────────────────────────────────────────────────────
  const verdict: Verdict = {
    verified: body.verified === true,
    score: typeof body.score === 'number' ? body.score : undefined,
    tier: typeof body.tier === 'string' ? body.tier : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
  };
  renderVerdict(root, verdict, body, () => {
    // Retry: re-mount the widget on the same container with the same
    // options. Returns a fresh promise that the integrator's original
    // .then() callback won't see (it has already resolved with the
    // first verdict), but `opts.onVerified` fires for each attempt.
    void fdkeyChallenge(container, opts);
  });
  opts.onVerified?.(verdict);
  return verdict;
}

// ── Internals ──────────────────────────────────────────────────────────────

function injectDefaultStyles(): void {
  const doc = document as Document & { [STYLE_INJECTED]?: boolean };
  if (doc[STYLE_INJECTED]) return;
  doc[STYLE_INJECTED] = true;
  const style = document.createElement('style');
  style.setAttribute('data-fdkey', 'default-css');
  style.textContent = DEFAULT_CSS;
  document.head.appendChild(style);
}

function estimateExpirySeconds(challenge: ChallengeResponse): number {
  if (!challenge.expires_at) return 60;
  const target = new Date(challenge.expires_at).getTime();
  const now = Date.now();
  return Math.max(0, Math.round((target - now) / 1000));
}

function waitForSubmission(
  submitBtn: HTMLButtonElement,
  timerEl: HTMLElement,
  totalSeconds: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    let remaining = totalSeconds;
    const tick = (): void => {
      timerEl.textContent = `${remaining}s`;
      timerEl.dataset.warning = remaining <= 10 ? 'true' : 'false';
      if (remaining <= 0) {
        clearInterval(interval);
        resolve();
        return;
      }
      remaining -= 1;
    };
    const interval = setInterval(tick, 1000);
    tick();
    submitBtn.addEventListener(
      'click',
      () => {
        clearInterval(interval);
        resolve();
      },
      { once: true }
    );
  });
}

function renderVerdict(
  root: HTMLElement,
  verdict: Verdict,
  rawBody: SubmitResponse,
  onRetry?: () => void
): void {
  // Remove submit button + puzzle groups so the verdict is the only thing
  // visible (the puzzles are now stale).
  root.querySelectorAll('.fdkey-puzzle-group, .fdkey-actions').forEach((el) => el.remove());

  const v = document.createElement('section');
  v.className = `fdkey-verdict ${verdict.verified ? 'fdkey-verdict-pass' : 'fdkey-verdict-fail'}`;
  v.setAttribute('aria-live', 'polite');

  const stamp = document.createElement('p');
  stamp.className = 'fdkey-verdict-stamp';
  stamp.textContent = verdict.verified ? 'Verified · AI' : 'Blocked';
  v.appendChild(stamp);

  const sub = document.createElement('p');
  sub.className = 'fdkey-verdict-sub';
  const parts: string[] = [];
  if (typeof verdict.score === 'number') {
    parts.push(`score ${Math.round(verdict.score * 100)} / 100`);
  }
  if (verdict.tier) parts.push(`tier ${verdict.tier}`);
  if (verdict.message) parts.push(verdict.message);
  sub.textContent = parts.join(' · ') || (verdict.verified ? 'OK' : 'Not enough signal of a capable LLM');
  v.appendChild(sub);

  if (onRetry) {
    const actions = document.createElement('div');
    actions.className = 'fdkey-actions';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'fdkey-submit';
    retryBtn.type = 'button';
    retryBtn.textContent = verdict.verified ? 'Try again' : 'Retry with new puzzles';
    retryBtn.addEventListener('click', () => onRetry(), { once: true });
    actions.appendChild(retryBtn);
    v.appendChild(actions);
  }

  root.appendChild(v);

  // Update the debug panel with the submit response too.
  const rawDetails = root.querySelector<HTMLDetailsElement>('.fdkey-raw');
  if (rawDetails) {
    const submitPre = document.createElement('pre');
    submitPre.textContent = `// POST submit response:\n${JSON.stringify(rawBody, null, 2)}`;
    rawDetails.appendChild(submitPre);
  }
}

function renderUnreachable(
  root: HTMLElement,
  err: unknown,
  opts: FdkeyChallengeOptions,
  container?: HTMLElement
): Verdict {
  // Clear puzzles; render an error block. We DON'T fake-pass: per the
  // SDK contract, the integrator decides what to do when the service is
  // unreachable (the SDK's `onVpsError: 'allow'` already covers that on
  // the server side; in the widget we just report what happened).
  root.querySelectorAll('.fdkey-puzzle-group, .fdkey-actions').forEach((el) => el.remove());

  // Distinguish a true outage (network error, no response body) from
  // an SDK-side 4xx-loud response (`fdkey_unexpected_4xx` / 503 with
  // a structured error body). The former is a service problem; the
  // latter is an integrator/SDK bug worth surfacing as such.
  const errStr = err instanceof Error ? err.message : String(err);
  const looksLikeClientBug = /fdkey_unexpected_4xx|invalid_body|HTTP 4\d\d/.test(errStr);
  const errEl = document.createElement('p');
  errEl.className = 'fdkey-error';
  errEl.setAttribute('aria-live', 'polite');
  errEl.textContent = looksLikeClientBug
    ? `Verification failed (integrator/SDK bug — check DevTools console): ${errStr}`
    : `FDKEY service unreachable: ${errStr}`;
  root.appendChild(errEl);

  // Offer retry from the error state too — transient outages happen.
  if (container) {
    const actions = document.createElement('div');
    actions.className = 'fdkey-actions';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'fdkey-submit';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener(
      'click',
      () => void fdkeyChallenge(container, opts),
      { once: true }
    );
    actions.appendChild(retryBtn);
    root.appendChild(actions);
  }

  const verdict: Verdict = {
    verified: false,
    error: looksLikeClientBug ? 'verification_failed' : 'service_unreachable',
  };
  opts.onVerified?.(verdict);
  return verdict;
}
