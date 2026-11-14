import type { InstrumentsResponse } from '@altis/shared/api/accreditation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { onTestFinished, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { ShellMeContext } from '@/lib/me';
import { json, problem, signedIn, type SignedIn } from '../fake-api';

// The harness of the Register tab and the evidence upload tests: the component under test is rendered on its own,
// inside the providers the shell gives every screen (the query client, the signed-in user, the UI language), and
// `fetch` answers from a table of `METHOD path` handlers (`:name` matches one path segment; the query string is kept
// apart). Every request is recorded with its parsed body and its place in Vitest's global call order, so a test can
// tell what was sent before what (a spy's `invocationCallOrder` is comparable).

export interface SentRequest {
  method: string;
  /** Relative to /api/v1, without the query. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  order: number;
}

/** A route's answer: a Response, or a body answered as 200 JSON (undefined: 204). */
export type RouteHandler = (req: SentRequest) => unknown;

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = decodeURIComponent(got[i]!);
    if (w.startsWith(':')) params[w.slice(1)] = g;
    else if (w !== g) return null;
  }
  return params;
}

/** The workspace configuration `GET accreditation/instruments` answers, with `evidenceMaxMb`. */
export function instrumentsAnswer(evidenceMaxMb = 5): InstrumentsResponse {
  return {
    instruments: [],
    config: {
      libraryType: 'sekolah',
      schoolYearStartMonth: 7,
      usedUnit: 'titles',
      evidenceMaxMb,
      componentLimitMb: 9,
      liveFrom: null,
      unknownMemberGroupDefault: null,
      dedupeMinutes: 60,
      dedupeLegacy: false,
    },
  };
}

/** A user holding only `accreditation.workspace.read`. */
export const readerMe = (): SignedIn => signedIn({ permissions: ['accreditation.workspace.read'] });

/**
 * Renders `ui` for `o.me` (an admin by default) in `o.locale` (Indonesian by default), answering `o.routes`. A handler
 * returns a Response, or a body answered as 200 JSON (undefined: 204); an unknown route answers 404 NOT_FOUND.
 */
export function renderWithServer(ui: ReactNode, o: { me?: SignedIn; routes: Record<string, RouteHandler>; locale?: 'id' | 'en' }) {
  const me = o.me ?? signedIn();
  const requests: SentRequest[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'https://altis.test');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const order = fetchMock.mock.invocationCallOrder[fetchMock.mock.calls.length - 1] ?? 0;
    if (path === 'auth/me' && method === 'GET') return json(me);
    for (const [key, handler] of Object.entries(o.routes)) {
      const [m, pattern] = key.split(' ') as [string, string];
      if (m !== method) continue;
      const params = match(pattern, path);
      if (params === null) continue;
      const req: SentRequest = { method, path, params, query: url.searchParams, body, order };
      requests.push(req);
      const answer = await handler(req);
      return answer instanceof Response ? answer : answer === undefined ? new Response(null, { status: 204 }) : json(answer);
    }
    requests.push({ method, path, params: {}, query: url.searchParams, body, order });
    return problem(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  onTestFinished(() => queryClient.clear());
  render(
    <QueryClientProvider client={queryClient}>
      <ShellMeContext.Provider value={me}>
        <I18nProvider locale={o.locale ?? 'id'}>{ui}</I18nProvider>
      </ShellMeContext.Provider>
    </QueryClientProvider>,
  );
  /** The requests to `method path` (path without the query), oldest first. */
  const sent = (method: string, path: string): SentRequest[] => requests.filter((r) => r.method === method && r.path === path);
  /** The requests other than `GET`, as `METHOD path`. */
  const writes = (): string[] => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  return { requests, sent, writes, queryClient, fetchMock };
}
