import type { BrowserContext, Page } from '@playwright/test';

// The CSP guard of every E2E page (spec §7.4 CSP; exit check A11: "Task 32 sees no CSP violation"):
//
// - an init script, installed before any script of the page runs, collects each `securitypolicyviolation` event into
//   `window.__csp` and hands it to the test through an exposed binding (a page's own array is gone after a
//   navigation; the binding's copy is not);
// - every console message of the context is read: Chromium also reports a violation there ("… violates the following
//   Content Security Policy directive …");
// - after each test (fixtures.ts) both must be empty: the binding's record, and `window.__csp` of every page still
//   open.
//
// Playwright evaluates the init script and the binding through the DevTools protocol, which the page's policy does
// not govern: the guard itself never causes a violation. The contexts never set `bypassCSP`.

/** The name of the binding the init script reports through. */
export const CSP_BINDING = '__altisCspReport';

/** One violation, as the init script reports it. */
export interface CspViolation {
  /** `effectiveDirective`, else `violatedDirective`. */
  directive: string;
  /** `blockedURI`: a URL, or `inline`, `eval`, `data`. */
  blocked: string;
  source: string;
  line: number;
  sample: string;
  /** The page's URL when it happened. */
  page: string;
}

/** Runs in every frame before the page's own scripts (Page.addScriptToEvaluateOnNewDocument). */
export const CSP_INIT_SCRIPT = `(function () {
  var list = [];
  try {
    Object.defineProperty(window, '__csp', { value: list, writable: false, configurable: false, enumerable: false });
  } catch (e) {
    return;
  }
  document.addEventListener('securitypolicyviolation', function (e) {
    var report = {
      directive: e.effectiveDirective || e.violatedDirective || '',
      blocked: e.blockedURI || '',
      source: e.sourceFile || '',
      line: e.lineNumber || 0,
      sample: e.sample || '',
      page: document.URL
    };
    list.push(report);
    var forward = window[${JSON.stringify(CSP_BINDING)}];
    if (typeof forward === 'function') {
      var pending = forward(report);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    }
  });
})();`;

/** Whether a console message reports a CSP violation (Chromium's wording names the policy). */
export function isCspConsoleMessage(text: string): boolean {
  return text.includes('Content Security Policy');
}

/** What the guard saw, one line per problem, in order. */
export class CspRecorder {
  readonly #entries: string[] = [];

  violation(v: CspViolation): void {
    const where = v.source === '' ? '' : ` (${v.source}:${v.line})`;
    const sample = v.sample === '' ? '' : `: ${v.sample}`;
    this.#entries.push(`violation ${v.directive} blocked ${v.blocked === '' ? '(nothing)' : v.blocked} on ${v.page}${where}${sample}`);
  }

  console(pageUrl: string, text: string): void {
    if (isCspConsoleMessage(text)) this.#entries.push(`console on ${pageUrl}: ${text}`);
  }

  /** A position to read the problems of what follows from (`problems(mark)`). */
  mark(): number {
    return this.#entries.length;
  }

  problems(since = 0): string[] {
    return this.#entries.slice(since);
  }
}

/** Installs the guard on `context`: the binding, the init script, and the console listener. */
export async function guardContext(context: BrowserContext, recorder: CspRecorder): Promise<void> {
  await context.exposeBinding(CSP_BINDING, (_source, report: CspViolation) => recorder.violation(report));
  await context.addInitScript({ content: CSP_INIT_SCRIPT });
  context.on('console', (message) => recorder.console(message.page()?.url() ?? '', message.text()));
}

/** `window.__csp` of `page` (nothing for a closed page). */
export async function pageViolations(page: Page): Promise<CspViolation[]> {
  if (page.isClosed()) return [];
  return page.evaluate(() => [...((window as unknown as { __csp?: CspViolation[] }).__csp ?? [])]);
}
