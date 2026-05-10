/** Server-to-server client for `api.fdkey.com`. The integrator's API key
 *  is used here and ONLY here — it never reaches the agent. */

import type {
  ChallengeBody,
  ChallengeFetchResponse,
  ChallengeReason,
  ChallengeRequiredResponse,
} from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;

interface VpsChallengeResponse {
  challenge_id: string;
  expires_at: string;
  expires_in_seconds?: number;
  difficulty: string;
  types_served: string[];
  puzzles: Record<string, unknown>;
}

export interface VpsSubmitResponse {
  verified: boolean;
  jwt?: string;
  types_passed?: number;
  types_served?: number;
  required_to_pass?: number;
  breakdown?: Record<string, unknown>;
}

export interface VpsClientOptions {
  vpsUrl: string;
  apiKey: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags?: Record<string, string>;
}

export class VpsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; message?: string; [k: string]: unknown },
  ) {
    super(body.error ?? `HTTP ${status}`);
  }
}

export class VpsClient {
  private readonly vpsUrl: string;

  constructor(private readonly opts: VpsClientOptions) {
    // Normalize: strip trailing slash so `${vpsUrl}/v1/...` doesn't produce
    // `https://api.fdkey.com//v1/...`. Most servers tolerate the double
    // slash, but it shows up in logs and confuses analytics.
    this.vpsUrl = opts.vpsUrl.replace(/\/+$/, '');
  }

  /** Fetch a fresh challenge from the VPS using the integrator's API key.
   *  Returns the puzzle JSON the agent should see. */
  async fetchChallenge(): Promise<VpsChallengeResponse> {
    const body: Record<string, unknown> = {
      difficulty: this.opts.difficulty,
      client_type: 'rest',
    };
    if (this.opts.tags && Object.keys(this.opts.tags).length > 0) {
      body.tags = this.opts.tags;
    }
    return this.post<VpsChallengeResponse>('/v1/challenge', body);
  }

  /** Forward an agent's answers to the VPS. Returns the raw VPS response
   *  including the JWT (which the SDK then verifies + discards — agent
   *  never sees it). */
  async submitAnswers(
    challengeId: string,
    answers: Record<string, unknown>,
  ): Promise<VpsSubmitResponse> {
    return this.post<VpsSubmitResponse>('/v1/submit', {
      challenge_id: challengeId,
      answers,
    });
  }

  /** Build the body fields shared by the 402 response and the explicit
   *  /fdkey/challenge fetch response. */
  private buildChallengeBody(
    challenge: VpsChallengeResponse,
    submitUrl: string,
  ): ChallengeBody {
    const expiresInSeconds =
      challenge.expires_in_seconds ??
      Math.max(
        0,
        Math.round((new Date(challenge.expires_at).getTime() - Date.now()) / 1000),
      );
    // `submit_url` is the machine-readable target for the agent's
    // submission — agents should parse this field, not the `hint`. The
    // hint is a human-readable explainer that inlines the URL for
    // debugging convenience. When the integrator is cross-origin and
    // hasn't set `publicBaseUrl`, the hint will refer to a relative
    // path that only makes sense on the integrator's own origin —
    // documented behavior; agents should rely on `submit_url`.
    return {
      challenge_id: challenge.challenge_id,
      expires_at: challenge.expires_at,
      expires_in_seconds: expiresInSeconds,
      difficulty: challenge.difficulty,
      types_served: challenge.types_served,
      puzzles: challenge.puzzles,
      submit_url: submitUrl,
      hint:
        `Solve the puzzles, then POST { challenge_id, answers } to ${submitUrl} ` +
        `on this same server. Your verified status will be tracked in your ` +
        `session — no token to manage. Retry the original request after a ` +
        `successful submit.`,
    };
  }

  /** 402 body — middleware path. Carries `error` + `reason` so callers can
   *  branch on it; otherwise identical to the GET /fdkey/challenge body. */
  buildChallengeRequiredResponse(
    challenge: VpsChallengeResponse,
    reason: ChallengeReason,
    submitUrl: string,
  ): ChallengeRequiredResponse {
    return {
      error: 'fdkey_verification_required',
      reason,
      ...this.buildChallengeBody(challenge, submitUrl),
    };
  }

  /** GET /fdkey/challenge body — explicit-fetch path. Clean shape (no
   *  `error` field on a 200 response). */
  buildChallengeFetchResponse(
    challenge: VpsChallengeResponse,
    submitUrl: string,
  ): ChallengeFetchResponse {
    return this.buildChallengeBody(challenge, submitUrl);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.vpsUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { _raw: text };
      }
    }
    if (!res.ok) {
      throw new VpsHttpError(res.status, parsed as { error?: string });
    }
    return parsed as T;
  }
}
