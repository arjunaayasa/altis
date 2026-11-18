// First, before any module that could build a Zod schema: Zod's eval probe is a CSP violation (lib/zod-jitless.ts).
import '@/lib/zod-jitless';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/fonts.css';
import '@/index.css';
import { bootNonce } from '@/lib/nonce';
import { Wizard } from './wizard';

// The install wizard's entry (install.html, the second Vite entry; spec §9.5, plan Task 30). The server serves the page
// at /install with the request's nonce in `<meta name="csp-nonce">` and in its Content-Security-Policy; the nonce goes
// to get-nonce before anything renders, as in the admin SPA.
bootNonce();

const container = document.getElementById('root');
if (container === null) throw new Error('install.html has no #root');
createRoot(container).render(
  <StrictMode>
    <Wizard />
  </StrictMode>,
);
