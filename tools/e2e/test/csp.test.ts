import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CSP_BINDING, CSP_INIT_SCRIPT, CspRecorder, isCspConsoleMessage, type CspViolation } from '../lib/csp.js';

/** Runs the init script in a sandbox with a minimal window/document and returns what a page would hold. */
function runInitScript(o: { binding?: boolean } = {}) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const forwarded: unknown[] = [];
  const document = {
    URL: 'http://127.0.0.1:4100/admin',
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  const window: Record<string, unknown> = {};
  if (o.binding === true) window[CSP_BINDING] = (report: unknown) => void forwarded.push(report);
  const context = vm.createContext({ window, document });
  vm.runInContext(CSP_INIT_SCRIPT, context);
  const fire = (event: Record<string, unknown>) => {
    for (const fn of listeners.get('securitypolicyviolation') ?? []) fn(event);
  };
  return { window, fire, forwarded };
}

const EVENT = {
  effectiveDirective: 'style-src-elem',
  violatedDirective: 'style-src',
  blockedURI: 'inline',
  sourceFile: 'http://127.0.0.1:4100/admin/assets/index-abc.js',
  lineNumber: 12,
  sample: '.x{color:red}',
};

describe('CSP_INIT_SCRIPT (installed in every page before its own scripts)', () => {
  it('collects every securitypolicyviolation event into window.__csp', () => {
    const page = runInitScript();
    expect(page.window['__csp']).toEqual([]);
    page.fire(EVENT);
    expect(page.window['__csp']).toEqual([
      {
        directive: 'style-src-elem',
        blocked: 'inline',
        source: 'http://127.0.0.1:4100/admin/assets/index-abc.js',
        line: 12,
        sample: '.x{color:red}',
        page: 'http://127.0.0.1:4100/admin',
      },
    ]);
  });

  it('also hands each one to the test through the exposed binding, so a navigation loses none', () => {
    const page = runInitScript({ binding: true });
    page.fire(EVENT);
    page.fire({ ...EVENT, effectiveDirective: '', violatedDirective: 'script-src', blockedURI: 'eval' });
    expect(page.forwarded).toHaveLength(2);
    expect((page.forwarded[1] as CspViolation).directive).toBe('script-src');
  });

  it('keeps its own array when a page assigns another one to window.__csp', () => {
    const page = runInitScript();
    vm.runInContext('window.__csp = []', vm.createContext({ window: page.window }));
    // The array is the recorder's own (read-only property): assigning another one does not hide the violations.
    page.fire(EVENT);
    expect((page.window['__csp'] as unknown[]).length).toBe(1);
  });
});

describe('isCspConsoleMessage', () => {
  it("matches Chromium's console report of a violation", () => {
    expect(
      isCspConsoleMessage(
        "Refused to apply inline style because it violates the following Content Security Policy directive: \"style-src 'self' 'nonce-abc'\".",
      ),
    ).toBe(true);
    expect(isCspConsoleMessage('Failed to load resource: the server responded with a status of 401 (Unauthorized)')).toBe(false);
  });
});

describe('CspRecorder', () => {
  it('is clean until a violation or a console report arrives, and then says what and where', () => {
    const recorder = new CspRecorder();
    expect(recorder.problems()).toEqual([]);
    recorder.violation({ directive: 'img-src', blocked: 'https://evil.test/x.png', source: '', line: 0, sample: '', page: 'http://127.0.0.1:4100/' });
    recorder.console('http://127.0.0.1:4100/admin', "Refused to load the image because it violates the following Content Security Policy directive: \"img-src 'self' data:\".");
    recorder.console('http://127.0.0.1:4100/admin', 'Download the React DevTools for a better development experience');
    const problems = recorder.problems();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^violation img-src blocked https:\/\/evil\.test\/x\.png on http:\/\/127\.0\.0\.1:4100\//);
    expect(problems[1]).toMatch(/^console on http:\/\/127\.0\.0\.1:4100\/admin: Refused to load the image/);
  });

  it('keeps the problems of a step apart (mark, then since)', () => {
    const recorder = new CspRecorder();
    recorder.console('p', 'Content Security Policy: one');
    const mark = recorder.mark();
    expect(recorder.problems(mark)).toEqual([]);
    recorder.console('p', 'Content Security Policy: two');
    expect(recorder.problems(mark)).toEqual(['console on p: Content Security Policy: two']);
    expect(recorder.problems()).toHaveLength(2);
  });
});
