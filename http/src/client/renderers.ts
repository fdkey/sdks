// Puzzle renderers.
//
// Each renderer is data-driven: it sniffs the puzzle's structural shape
// (does it have `questions[]`? does it have `concept` + `options[]`?
// does it have a `prompt`?) and renders accordingly. When the VPS adds
// a new puzzle type with a new shape, add a new renderer here and
// append it to the dispatch chain — existing integrators continue to
// work, new types render automatically.
//
// Renderers produce **semantic HTML** — the primary consumer is an
// LLM agent reading `document.body.innerText` or the accessibility
// tree. Visual styling (see `css.ts`) is bonus for humans.

import type { PuzzleRenderer } from './types.js';

/** Renders a TYPE-1-style multi-choice puzzle set. Recognized shape:
 *  { instructions, questions: [{ n, question, options[] }] }. Options
 *  are pre-letter-prefixed by the VPS ("A. word", "B. word", ...).
 *  Submit-side wire format: array of `{ n, answer: letter }`. */
export const mcqRenderer: PuzzleRenderer = {
  id: 'mcq',
  match(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return Array.isArray((d as { questions?: unknown }).questions);
  },
  render(typeKey, data, section) {
    const d = data as { instructions?: string; questions?: Array<{ n?: number; question?: string; options?: unknown[] }> };
    section.dataset.type = typeKey;
    section.dataset.renderer = this.id;
    if (typeof d.instructions === 'string') {
      const p = document.createElement('p');
      p.className = 'fdkey-instructions';
      p.dataset.type = typeKey;
      p.textContent = d.instructions;
      section.appendChild(p);
    }
    const questions = d.questions ?? [];
    questions.forEach((q, idx) => {
      const n = typeof q.n === 'number' ? q.n : idx + 1;
      const article = document.createElement('article');
      article.className = 'fdkey-puzzle';
      article.dataset.type = typeKey;
      article.dataset.n = String(n);

      const qp = document.createElement('p');
      qp.className = 'fdkey-question';
      qp.textContent = typeof q.question === 'string' ? q.question : '';
      article.appendChild(qp);

      const ul = document.createElement('ul');
      ul.className = 'fdkey-options';
      (q.options ?? []).forEach((opt) => {
        const li = document.createElement('li');
        li.textContent = String(opt);
        ul.appendChild(li);
      });
      article.appendChild(ul);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'fdkey-input';
      input.name = `${typeKey}[${idx}].answer`;
      input.dataset.n = String(n);
      input.dataset.type = typeKey;
      input.placeholder = 'A, B, C, or D';
      input.autocomplete = 'off';
      input.autocapitalize = 'characters';
      input.spellcheck = false;
      input.maxLength = 3;
      article.appendChild(input);

      section.appendChild(article);
    });
  },
  extract(typeKey, section) {
    const inputs = section.querySelectorAll<HTMLInputElement>(
      `.fdkey-input[data-type="${typeKey}"]`
    );
    const items: Array<{ n: number; answer: string }> = [];
    inputs.forEach((inp) => {
      const n = Number.parseInt(inp.dataset.n ?? '0', 10) || items.length + 1;
      // VPS scoreT1 is tolerant (extracts the first \b[A-Z]\b). Pass the
      // user's typed value through verbatim — VPS scorer does the rest.
      items.push({ n, answer: (inp.value ?? '').trim().toUpperCase() });
    });
    return items;
  },
};

/** Renders a TYPE-3-style ranking puzzle. Recognized shape:
 *  { instructions, n, concept, options[] } where options are
 *  pre-letter-prefixed ("A. word", "B. word", ...).
 *  Submit-side wire format: `{ n, answer: [letters] }`. */
export const rankingRenderer: PuzzleRenderer = {
  id: 'ranking',
  match(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return typeof d.concept === 'string' && Array.isArray(d.options);
  },
  render(typeKey, data, section) {
    const d = data as { instructions?: string; n?: number; concept?: string; options?: unknown[] };
    section.dataset.type = typeKey;
    section.dataset.renderer = this.id;
    if (typeof d.instructions === 'string') {
      const p = document.createElement('p');
      p.className = 'fdkey-instructions';
      p.dataset.type = typeKey;
      p.textContent = d.instructions;
      section.appendChild(p);
    }

    const n = typeof d.n === 'number' ? d.n : 1;
    const article = document.createElement('article');
    article.className = 'fdkey-puzzle';
    article.dataset.type = typeKey;
    article.dataset.n = String(n);

    const cp = document.createElement('p');
    cp.className = 'fdkey-concept';
    cp.textContent = `Concept: ${typeof d.concept === 'string' ? d.concept : ''}`;
    article.appendChild(cp);

    const ul = document.createElement('ul');
    ul.className = 'fdkey-options';
    (d.options ?? []).forEach((opt) => {
      const li = document.createElement('li');
      li.textContent = String(opt);
      ul.appendChild(li);
    });
    article.appendChild(ul);

    const ta = document.createElement('textarea');
    ta.className = 'fdkey-textarea';
    ta.name = `${typeKey}.answer`;
    ta.dataset.n = String(n);
    ta.dataset.type = typeKey;
    ta.placeholder = 'A > B > C > D > ...';
    ta.autocomplete = 'off';
    ta.spellcheck = false;
    article.appendChild(ta);

    section.appendChild(article);
  },
  extract(typeKey, section) {
    const ta = section.querySelector<HTMLTextAreaElement>(
      `.fdkey-textarea[data-type="${typeKey}"]`
    );
    const raw = ta?.value ?? '';
    const n = Number.parseInt(ta?.dataset.n ?? '1', 10) || 1;
    // VPS scoreT3 is tolerant — it accepts arrays of "A", "B.", "**B**",
    // "the answer is B", etc., and falls back to word parse. Split the
    // raw input on >, comma, semicolon, whitespace and pass through.
    const tokens = raw
      .split(/[>,;\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return { n, answer: tokens };
  },
};

/** Renders a free-form puzzle (recognized shape: { instructions, n, prompt }).
 *  Provides a single textarea. Submit-side wire format:
 *  `{ n, answer: string }`. Reserved for future puzzle types 4-6. */
export const freeformRenderer: PuzzleRenderer = {
  id: 'freeform',
  match(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return typeof d.prompt === 'string';
  },
  render(typeKey, data, section) {
    const d = data as { instructions?: string; n?: number; prompt?: string };
    section.dataset.type = typeKey;
    section.dataset.renderer = this.id;
    if (typeof d.instructions === 'string') {
      const p = document.createElement('p');
      p.className = 'fdkey-instructions';
      p.dataset.type = typeKey;
      p.textContent = d.instructions;
      section.appendChild(p);
    }
    const n = typeof d.n === 'number' ? d.n : 1;
    const article = document.createElement('article');
    article.className = 'fdkey-puzzle';
    article.dataset.type = typeKey;
    article.dataset.n = String(n);

    const qp = document.createElement('p');
    qp.className = 'fdkey-question';
    qp.textContent = typeof d.prompt === 'string' ? d.prompt : '';
    article.appendChild(qp);

    const ta = document.createElement('textarea');
    ta.className = 'fdkey-textarea';
    ta.name = `${typeKey}.answer`;
    ta.dataset.n = String(n);
    ta.dataset.type = typeKey;
    ta.placeholder = 'Type your answer here…';
    ta.autocomplete = 'off';
    article.appendChild(ta);

    section.appendChild(article);
  },
  extract(typeKey, section) {
    const ta = section.querySelector<HTMLTextAreaElement>(
      `.fdkey-textarea[data-type="${typeKey}"]`
    );
    const n = Number.parseInt(ta?.dataset.n ?? '1', 10) || 1;
    return { n, answer: (ta?.value ?? '').trim() };
  },
};

/** Last-resort renderer: dumps the unknown puzzle JSON in a `<pre>`
 *  block and provides a single textarea named after the type key. Better
 *  to render *something* the agent can read than to crash. Newer SDK
 *  versions add proper renderers for newly-served types; this just keeps
 *  old clients alive when the VPS rolls out something they don't know yet. */
export const fallbackRenderer: PuzzleRenderer = {
  id: 'fallback',
  match(): boolean {
    return true;
  },
  render(typeKey, data, section) {
    section.dataset.type = typeKey;
    section.dataset.renderer = this.id;
    const d = (data ?? {}) as { instructions?: string; n?: number };
    if (typeof d.instructions === 'string') {
      const p = document.createElement('p');
      p.className = 'fdkey-instructions';
      p.dataset.type = typeKey;
      p.textContent = d.instructions;
      section.appendChild(p);
    }
    const article = document.createElement('article');
    article.className = 'fdkey-puzzle';
    article.dataset.type = typeKey;
    const n = typeof d.n === 'number' ? d.n : 1;
    article.dataset.n = String(n);

    const note = document.createElement('p');
    note.className = 'fdkey-question';
    note.textContent = `Unknown puzzle shape for type "${typeKey}". Raw data shown below; please update the SDK.`;
    article.appendChild(note);

    const pre = document.createElement('pre');
    pre.style.fontSize = '11px';
    pre.style.padding = '0.5rem';
    pre.style.background = 'rgba(0,0,0,0.25)';
    pre.style.borderRadius = '4px';
    pre.style.overflow = 'auto';
    pre.textContent = JSON.stringify(data, null, 2);
    article.appendChild(pre);

    const ta = document.createElement('textarea');
    ta.className = 'fdkey-textarea';
    ta.name = `${typeKey}.answer`;
    ta.dataset.n = String(n);
    ta.dataset.type = typeKey;
    ta.placeholder = 'Type your answer here (best-effort)';
    article.appendChild(ta);

    section.appendChild(article);
  },
  extract(typeKey, section) {
    const ta = section.querySelector<HTMLTextAreaElement>(
      `.fdkey-textarea[data-type="${typeKey}"]`
    );
    const n = Number.parseInt(ta?.dataset.n ?? '1', 10) || 1;
    return { n, answer: (ta?.value ?? '').trim() };
  },
};

/** Dispatch chain — order matters; first match wins. More specific
 *  patterns come first; the fallback is last and matches anything. */
export const RENDERERS: PuzzleRenderer[] = [
  mcqRenderer,
  rankingRenderer,
  freeformRenderer,
  fallbackRenderer,
];

/** Pick the renderer for a given puzzle's data. */
export function pickRenderer(puzzleData: unknown): PuzzleRenderer {
  for (const r of RENDERERS) {
    if (r.match(puzzleData)) return r;
  }
  // Unreachable — fallback matches everything — but TS likes the return.
  return fallbackRenderer;
}
