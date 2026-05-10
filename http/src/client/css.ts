// Default styles for the FDKEY challenge widget.
//
// Deliberately minimal — agents don't read CSS, they read DOM text.
// Humans on a demo page see something usable, not "designed". Real
// marketing-site integrators override these via `.fdkey-*` class names
// or disable them entirely with `defaultStyles: false`.
//
// All selectors are prefixed `.fdkey-` to avoid colliding with the
// integrator's own class names. Injected as a `<style>` tag prepended
// to the widget's container.

export const DEFAULT_CSS = `
.fdkey-challenge {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 14px;
  line-height: 1.55;
  color: inherit;
  display: flex;
  flex-direction: column;
  gap: 1.4rem;
}
.fdkey-challenge[hidden] { display: none; }

.fdkey-meta {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  opacity: 0.7;
}
.fdkey-timer { font-weight: 600; }
.fdkey-timer[data-warning="true"] { color: #ff7a6b; }

.fdkey-instructions {
  margin: 0 0 .6rem;
  padding: .7rem .9rem;
  background: rgba(127,127,127,0.07);
  border-left: 2px solid currentColor;
  border-radius: 2px 6px 6px 2px;
  opacity: 0.92;
}

.fdkey-puzzle {
  display: flex;
  flex-direction: column;
  gap: .5rem;
  padding: .8rem 0;
  border-top: 1px solid rgba(127,127,127,0.18);
}
.fdkey-puzzle:first-of-type { border-top: 0; padding-top: 0; }

.fdkey-question, .fdkey-concept {
  margin: 0;
  font-weight: 600;
}
.fdkey-concept { font-size: 1.05rem; }

.fdkey-options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: .35rem .6rem;
}
.fdkey-options li {
  padding: .15rem .45rem;
  background: rgba(127,127,127,0.08);
  border-radius: 4px;
  font-size: .92em;
}

.fdkey-input, .fdkey-textarea {
  font: inherit;
  padding: .5rem .65rem;
  border: 1px solid rgba(127,127,127,0.35);
  border-radius: 6px;
  background: rgba(127,127,127,0.04);
  color: inherit;
  width: 100%;
  box-sizing: border-box;
}
.fdkey-input:focus, .fdkey-textarea:focus {
  outline: none;
  border-color: #7cff6b;
  background: rgba(124,255,107,0.05);
}
.fdkey-textarea {
  resize: vertical;
  min-height: 4.5em;
  font-family: ui-monospace, monospace;
}

.fdkey-actions {
  display: flex;
  gap: .6rem;
  align-items: center;
  justify-content: flex-end;
  margin-top: .4rem;
}
.fdkey-submit {
  font: inherit;
  padding: .5rem 1.1rem;
  border: 1px solid #7cff6b;
  background: transparent;
  color: #7cff6b;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}
.fdkey-submit:hover { background: #7cff6b; color: #000; }
.fdkey-submit:disabled { opacity: .5; cursor: not-allowed; }

.fdkey-verdict {
  margin-top: .6rem;
  padding: 1rem 1.2rem;
  border-radius: 8px;
  text-align: center;
  border: 1px solid rgba(127,127,127,0.3);
}
.fdkey-verdict-stamp {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 .35rem;
}
.fdkey-verdict-sub {
  margin: 0;
  font-size: .92em;
  opacity: 0.75;
}
.fdkey-verdict-pass .fdkey-verdict-stamp { color: #7cff6b; }
.fdkey-verdict-fail .fdkey-verdict-stamp { color: #ff7a6b; }

.fdkey-error {
  margin: 0;
  padding: .9rem 1.1rem;
  background: rgba(255,122,107,0.08);
  border: 1px solid rgba(255,122,107,0.35);
  border-radius: 6px;
  color: #ff7a6b;
}

.fdkey-raw {
  margin-top: 1rem;
  font-size: .82em;
  opacity: 0.7;
}
.fdkey-raw > summary { cursor: pointer; user-select: none; }
.fdkey-raw > pre {
  margin: .5rem 0 0;
  padding: .75rem;
  background: rgba(0,0,0,0.3);
  border-radius: 6px;
  overflow: auto;
  max-height: 280px;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
`;
