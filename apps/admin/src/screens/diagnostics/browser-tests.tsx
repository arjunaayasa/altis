import type { ProbeResultResponse } from '@altis/shared/api/diagnostics';
import { useQueryClient } from '@tanstack/react-query';
import { PlayIcon, SquareIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Notice, NoticeAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { problemText } from '@/lib/form-errors';
import { ME_KEY, meQuery } from '@/lib/me';
import { probeResultBody, runBrowserProbes, type ProbeResults } from '@/lib/probes';
import { useBytes } from '@/screens/backups/upload';

/**
 * "Uji peramban" of Diagnostik (spec §11, §2.4, P10, P15; routes `diagnostics.probe.*`, `diagnostics.probe_result`;
 * decisions C22, C35; 1c Task 32): runs the browser test of lib/probes.ts (Task 30) against `/api/v1/diagnostics/probe`
 * and posts its results with `POST diagnostics/probe-result` (`system.diagnostics.manage`), which the server keeps as
 * `system.probe` (the hints `auth/me` gives the realtime and upload clients: SSE or polling, method override, the
 * chunk size) and from which it judges `system.ip_trust`.
 *
 * - The probe routes are reached with fetch directly, never through lib/api.ts: the methods probe must see the real
 *   PUT, PATCH and DELETE (a WAF's refusal is the answer it looks for; the server refuses an overridden probe). Their
 *   writes carry the session's CSRF token, read fresh from `auth/me` just before the test (a token another tab rotated
 *   would read as a refusal of the methods), and every answer feeds the API client's build check and token rotation
 *   (`onResponse`), as lib/api.ts does for its own requests.
 * - "Hentikan uji" (and leaving the page) aborts the test; nothing is posted then.
 * - Afterwards the report and `auth/me` are read again (`onSaved`, ME_KEY): the transport, the method override and the
 *   chunk size may have changed.
 */

/** What every answer of a probe route feeds: the build check and the CSRF token rotation of the API client. */
function observeProbeResponse(res: Response): void {
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') setCsrfToken(rotated);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

type Outcome = { kind: 'success' | 'error' | 'info'; text: string } | null;

/** The browser test section (for a holder of `system.diagnostics.manage`); `onSaved` runs once the results are kept. */
export function BrowserTests({ onSaved }: { onSaved(): void }) {
  const t = useT();
  const bytes = useBytes();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [results, setResults] = useState<{ probes: ProbeResults; answer: ProbeResultResponse } | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);

  const start = async (): Promise<void> => {
    if (run.current !== null) return;
    const controller = new AbortController();
    run.current = controller;
    setRunning(true);
    setOutcome(null);
    try {
      await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      controller.signal.throwIfAborted();
      const probes = await runBrowserProbes({
        base: '/api/v1/diagnostics/probe',
        csrf: () => csrfToken() ?? '',
        signal: controller.signal,
        onResponse: observeProbeResponse,
      });
      const answer = await api<ProbeResultResponse>('POST', 'diagnostics/probe-result', probeResultBody(probes), { signal: controller.signal });
      setResults({ probes, answer });
      setOutcome({ kind: 'success', text: t('diagnostics.probe.done') });
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    } catch (e) {
      setOutcome(controller.signal.aborted ? { kind: 'info', text: t('diagnostics.probe.stopped') } : { kind: 'error', text: problemText(t, e) });
    } finally {
      if (run.current === controller) run.current = null;
      setRunning(false);
    }
  };

  const passed = (ok: boolean): string => t(ok ? 'diagnostics.probe.passed' : 'diagnostics.probe.failed');
  const method = (ok: boolean): string => t(ok ? 'diagnostics.http.allowed' : 'diagnostics.http.blocked');

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id={titleId} className="text-base font-semibold">
        {t('diagnostics.probe.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('diagnostics.probe.description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={running} onClick={() => void start()}>
          <PlayIcon aria-hidden="true" />
          {t('diagnostics.probe.run')}
        </Button>
        {running && (
          <Button variant="outline" onClick={() => run.current?.abort()}>
            <SquareIcon aria-hidden="true" />
            {t('diagnostics.probe.stop')}
          </Button>
        )}
      </div>
      {running && <NoticeAlert>{t('diagnostics.probe.running')}</NoticeAlert>}
      {outcome !== null &&
        (outcome.kind === 'info' ? <NoticeAlert>{outcome.text}</NoticeAlert> : <Notice kind={outcome.kind}>{outcome.text}</Notice>)}
      {results !== null && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('diagnostics.probe.results')}</h3>
          <dl className="flex flex-col gap-2">
            <Row label={t('diagnostics.probe.polling')}>{passed(results.probes.polling)}</Row>
            <Row label={t('diagnostics.probe.sse')}>{passed(results.probes.sse)}</Row>
            <Row label="PUT">{method(results.probes.methods.put)}</Row>
            <Row label="PATCH">{method(results.probes.methods.patch)}</Row>
            <Row label="DELETE">{method(results.probes.methods.delete)}</Row>
            <Row label={t('diagnostics.probe.chunk')}>
              {results.probes.chunkBytes === null ? t('diagnostics.probe.chunk_none') : bytes(results.probes.chunkBytes)}
            </Row>
            <Row label={t('diagnostics.probe.xff')}>
              {t(results.answer.spoofable ? 'diagnostics.probe.spoofable' : 'diagnostics.probe.not_spoofable')}
            </Row>
            <Row label={t('diagnostics.network.suggested')}>{results.answer.suggestedHops}</Row>
          </dl>
        </div>
      )}
    </section>
  );
}
