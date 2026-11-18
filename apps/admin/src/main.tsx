// First, before any module that could build a Zod schema: Zod's eval probe is a CSP violation (lib/zod-jitless.ts).
import '@/lib/zod-jitless';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './index.css';
import { ApiError } from '@/lib/api';
import { bootNonce } from '@/lib/nonce';
import { connectApiClient, createAppRouter } from '@/routes';

// The admin SPA's entry (spec §4.8). The CSP nonce goes to get-nonce before anything renders.
bootNonce();

/** A failed query is retried (twice) only when the server may answer differently: no response, or a 5xx/429. */
function retryQuery(failures: number, error: unknown): boolean {
  if (failures >= 2) return false;
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: retryQuery, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

const router = createAppRouter({ queryClient });

// The API client lives outside React: it moves through the router (no reload), and forgets the session it lost.
connectApiClient(router, queryClient);

const container = document.getElementById('root');
if (container === null) throw new Error('index.html has no #root');
createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
