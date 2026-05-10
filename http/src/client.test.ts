// Client widget tests. Focused on dispatch logic — the part most likely
// to regress when new puzzle types ship. Full DOM-level rendering tests
// run in the e2e flow on the live demo (smoke against api.fdkey.com).

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  pickRenderer,
  mcqRenderer,
  rankingRenderer,
  freeformRenderer,
  fallbackRenderer,
  RENDERERS,
} from './client/renderers.js';

describe('client dispatch: pickRenderer by structural pattern', () => {
  it('picks the MCQ renderer when puzzle has a `questions` array', () => {
    const data = {
      instructions: 'Pick a letter.',
      questions: [
        { n: 1, question: 'Which?', options: ['A. foo', 'B. bar'] },
      ],
    };
    expect(pickRenderer(data).id).toBe('mcq');
  });

  it('picks the ranking renderer when puzzle has `concept` + `options`', () => {
    const data = {
      instructions: 'Rank.',
      n: 1,
      concept: 'headlights',
      options: ['A. lamp', 'B. wheel', 'C. eyes'],
    };
    expect(pickRenderer(data).id).toBe('ranking');
  });

  it('picks the freeform renderer for { prompt } shape', () => {
    const data = { instructions: 'Solve.', n: 1, prompt: 'name a primary color' };
    expect(pickRenderer(data).id).toBe('freeform');
  });

  it('falls back when the puzzle shape is unknown', () => {
    const data = { instructions: 'Mystery type', n: 1, rule_examples: [] };
    expect(pickRenderer(data).id).toBe('fallback');
  });

  it('falls back for null / undefined / non-object input', () => {
    expect(pickRenderer(null).id).toBe('fallback');
    expect(pickRenderer(undefined).id).toBe('fallback');
    expect(pickRenderer('string-not-object').id).toBe('fallback');
    expect(pickRenderer(42).id).toBe('fallback');
  });

  it('renderer chain order: more specific first, fallback last', () => {
    // Order matters: fallback matches anything, so it must come last.
    expect(RENDERERS[RENDERERS.length - 1].id).toBe('fallback');
    // The other three are tried in declared order; first match wins.
    const ids = RENDERERS.map((r) => r.id);
    expect(ids).toContain('mcq');
    expect(ids).toContain('ranking');
    expect(ids).toContain('freeform');
  });

  it('MCQ shape with empty `questions` still matches the MCQ renderer', () => {
    // Defensive: a real challenge could theoretically have 0 questions
    // (e.g. all puzzles filtered out demo-only). Renderer should still
    // accept the shape and render an empty section.
    expect(pickRenderer({ questions: [] }).id).toBe('mcq');
  });

  it('ranking pattern wins over fallback even with missing instructions', () => {
    const data = { n: 1, concept: 'foo', options: ['A. x'] };
    expect(pickRenderer(data).id).toBe('ranking');
  });

  it('each renderer exposes the PuzzleRenderer contract: id, match, render, extract', () => {
    for (const r of [mcqRenderer, rankingRenderer, freeformRenderer, fallbackRenderer]) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.match).toBe('function');
      expect(typeof r.render).toBe('function');
      expect(typeof r.extract).toBe('function');
    }
  });
});
