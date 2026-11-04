import { setNonce } from 'get-nonce';

/** The placeholder of index.html (D31); the server replaces it with the request's nonce. */
const PLACEHOLDER = '__CSP_NONCE__';

/**
 * Hands the page's CSP nonce to get-nonce (spec §4.8), which the `<style>` elements Radix inserts read: the policy
 * allows styles from 'self' and from that nonce only. Called before `createRoot`. Returns the nonce, or null when the
 * page has none (no tag, or the placeholder of an index.html the server did not serve: Vite's dev server, no CSP).
 */
export function bootNonce(): string | null {
  const content = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
  if (content === '' || content === PLACEHOLDER) return null;
  setNonce(content);
  return content;
}
