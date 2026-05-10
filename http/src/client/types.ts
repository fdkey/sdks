// Client-side widget types.
//
// All types are local to the widget so the browser bundle has zero
// dependency on the server-side `@fdkey/http` types (which import
// `jose`, server-only things, etc.).

/** Shape of the challenge response the widget consumes. Mirrors the
 *  wire format `@fdkey/http`'s server-side hono adapter returns from
 *  GET /fdkey/challenge — but typed loosely so unknown future puzzle
 *  shapes still parse. */
export interface ChallengeResponse {
  challenge_id: string;
  expires_at: string;
  expires_in_seconds?: number;
  difficulty?: string;
  types_served?: string[];
  /** Per-type puzzle data. Each key's value shape is type-specific —
   *  see the renderer dispatch in `dispatch.ts` for structural patterns. */
  puzzles?: Record<string, unknown>;
  /** Where to POST answers. The widget uses this directly so it adapts
   *  to whatever path the integrator mounted the SDK at. */
  submit_url?: string;
  hint?: string;
}

/** Shape of the submit response the widget renders verdicts from. */
export interface SubmitResponse {
  verified: boolean;
  score?: number;
  tier?: string;
  message?: string;
  /** Extra fields the VPS passes through (types_passed, types_served,
   *  required_to_pass, breakdown, etc.). Loosely typed because we don't
   *  consume them in the widget today but they're useful for debugging
   *  and for integrators who read them via the resolved Promise. */
  [k: string]: unknown;
}

/** Resolved verdict from `fdkeyChallenge()`. */
export interface Verdict {
  verified: boolean;
  score?: number;
  tier?: string;
  message?: string;
  /** Set when the widget couldn't reach the SDK or the VPS was down.
   *  Distinct from `verified: false` (the agent's submission was
   *  scored and failed) — `error: 'service_unreachable'` means we
   *  never got a verdict. */
  error?: string;
}

/** Options passed to `fdkeyChallenge(el, opts)`. */
export interface FdkeyChallengeOptions {
  /** Path prefix where the integrator mounted the SDK's routes.
   *  Default: '/fdkey'. The widget fetches `${endpoint}/challenge` and
   *  reads `submit_url` from the response. */
  endpoint?: string;
  /** Inject default CSS into the container. Default: true. Set false
   *  to render bare semantic HTML with no styling — useful when the
   *  integrator wants full control over the look. */
  defaultStyles?: boolean;
  /** Show a start button instead of fetching the challenge immediately.
   *  Default: false (auto-start). Agents don't click buttons; humans
   *  on a demo page sometimes want to opt in. */
  requireStart?: boolean;
  /** Optional callback fired once the verdict is in. Same data as the
   *  resolved Promise; provided for fire-and-forget consumers. */
  onVerified?: (verdict: Verdict) => void;
}

/** Per-puzzle-type renderer. Each renderer knows how to detect a
 *  structural pattern (e.g. "has a `questions` array"), render the
 *  puzzle into the DOM, and read user-typed answers back into the
 *  wire format. New puzzle types are added by writing a new renderer
 *  + appending it to the dispatch chain in `dispatch.ts`. */
export interface PuzzleRenderer {
  /** Stable identifier — used in CSS class names and debug attributes. */
  readonly id: string;
  /** Return true if this renderer can handle the given puzzle data
   *  shape. Renderers are tried in order; first match wins. */
  match(puzzleData: unknown): boolean;
  /** Build DOM for this puzzle inside `section`. */
  render(typeKey: string, puzzleData: unknown, section: HTMLElement): void;
  /** Read user-entered values back into the wire format. Returns the
   *  value to assign to `body.answers[typeKey]`. Implementations should
   *  always return SOMETHING parseable — empty inputs become empty
   *  strings/arrays, never undefined — so the submit always has data
   *  for the VPS to score. */
  extract(typeKey: string, section: HTMLElement): unknown;
}
