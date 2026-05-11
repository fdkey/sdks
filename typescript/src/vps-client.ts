import type { ChallengeMeta, IVpsRouter } from './types.js';

export interface ChallengeResponse {
  challenge_id: string;
  expires_at: string; // ISO timestamp
  expires_in_seconds?: number; // VPS may include this; SDK falls back to computing from expires_at
  difficulty: string;
  types_served: string[];
  header?: string;
  puzzles: Record<string, unknown>;
  footer?: string;
  /** Wire-format teaching aid added by the VPS (2026-05-11+). Shows the
   *  exact JSON the agent should POST to /v1/submit. Contains a `_note`
   *  flagging that the placeholder letters must be replaced, and a `body`
   *  with the literal shape. Optional for older VPS versions. */
  example_submission?: {
    _note?: string;
    body?: {
      challenge_id?: string;
      answers?: Record<string, unknown>;
    };
  };
}

export interface SubmitResponse {
  verified: boolean;
  jwt?: string;
  types_passed?: number;
  types_served?: number;
  required_to_pass?: number;
  breakdown?: Record<string, unknown>;
}

function hasValue(obj: object): boolean {
  return Object.values(obj).some((v) => v !== undefined && v !== null);
}

export class VpsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { error?: string; message?: string; [k: string]: unknown }
  ) {
    super(body.error ?? `HTTP ${status}`);
  }
}

export class VpsClient {
  constructor(
    private readonly router: IVpsRouter,
    private readonly apiKey: string,
    private readonly difficulty: string
  ) {}

  async fetchChallenge(meta?: ChallengeMeta): Promise<ChallengeResponse> {
    const target = await this.router.getTarget();
    const body: Record<string, unknown> = {
      difficulty: this.difficulty,
      client_type: 'mcp',
    };
    // Only include each block if at least one field inside is populated —
    // keeps the wire payload clean when the caller has no metadata yet
    // (e.g. challenge fetched before any tool call has fired oninitialized).
    if (meta?.agent && hasValue(meta.agent)) body.agent = meta.agent;
    if (meta?.integrator && hasValue(meta.integrator)) body.integrator = meta.integrator;
    if (meta?.tags && Object.keys(meta.tags).length > 0) body.tags = meta.tags;
    return this.post(target, '/v1/challenge', body) as Promise<ChallengeResponse>;
  }

  async submitAnswers(
    challengeId: string,
    answers: Record<string, unknown>
  ): Promise<SubmitResponse> {
    const target = await this.router.getTarget();
    return this.post(target, '/v1/submit', {
      challenge_id: challengeId, answers,
    }) as Promise<SubmitResponse>;
  }

  private async post(
    target: { url: string; dispatcher?: unknown; ip?: string },
    path: string,
    body: unknown
  ): Promise<unknown> {
    const fullUrl = `${target.url}${path}`;
    // Build init separately so we only attach `dispatcher` when present.
    // Workers/Bun/Deno don't have undici Agent, so dispatcher will be
    // undefined and the global fetch is invoked with a clean RequestInit.
    const init: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    };
    if (target.dispatcher) init.dispatcher = target.dispatcher;
    let res: Response;
    try {
      res = await fetch(fullUrl, init as RequestInit);
    } catch (err) {
      // Network failure / timeout — surface as failure to caller, mark endpoint
      this.router.recordFailure(target.ip);
      throw err;
    }

    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
    }

    if (!res.ok) {
      // 4xx = client/state error from VPS — do NOT mark endpoint as failed
      // 5xx = server error — mark endpoint as failed for failover
      if (res.status >= 500) this.router.recordFailure(target.ip);
      throw new VpsHttpError(res.status, parsed as { error?: string });
    }
    return parsed;
  }
}
