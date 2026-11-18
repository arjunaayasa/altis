import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useRunEnded } from '@/screens/catalog/migration';
import { CUTOVER_KEY } from '@/screens/catalog/migration/people';

// The end of a migration run makes the cut-over checklist stale, so the checklist shown next is read again instead of
// the one cached while the run was going (whose reconciliation and readiness came before the run's end). The page
// tests run without a query cache to speak of, so this is checked on the hook and a query client that keeps its data
// fresh for a minute, as the app's would for the checklist's lifetime.

const RUN_ID = '01JBZ0000000000000000000RA';

function setup(): { queryClient: QueryClient; wrapper: (p: { children: ReactNode }) => ReactNode } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  queryClient.setQueryData(CUTOVER_KEY, { runId: RUN_ID, reconciled: false, ready: false });
  queryClient.setQueryData(['catalog', 'runs', RUN_ID], { id: RUN_ID, status: 'running' });
  queryClient.setQueryData(['catalog', 'runs', { kind: 'migration' }], { items: [] });
  queryClient.setQueryData(['catalog', 'config'], { other: true });
  return { queryClient, wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> };
}

describe('useRunEnded', () => {
  it('marks the cut-over checklist stale with the run and the runs list, and nothing else', () => {
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(() => useRunEnded(RUN_ID), { wrapper });
    expect(queryClient.getQueryState(CUTOVER_KEY)?.isInvalidated).toBe(false);
    act(() => result.current());
    const invalidated = (key: readonly unknown[]): boolean | undefined => queryClient.getQueryState(key)?.isInvalidated;
    expect(invalidated(CUTOVER_KEY), 'the cut-over checklist').toBe(true);
    expect(invalidated(['catalog', 'runs', RUN_ID]), 'the run').toBe(true);
    expect(invalidated(['catalog', 'runs', { kind: 'migration' }]), 'the runs list').toBe(true);
    expect(invalidated(['catalog', 'config']), 'an unrelated query').toBe(false);
  });
});
