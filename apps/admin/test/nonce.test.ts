import { afterEach, describe, expect, it, vi } from 'vitest';

// Spec §4.8: the server puts the request's CSP nonce into `<meta name="csp-nonce">`; the SPA hands it to get-nonce
// before React renders, so the `<style>` elements Radix (react-remove-scroll) inserts carry it (style-src 'nonce-…').

const setNonce = vi.fn();
vi.mock('get-nonce', () => ({ setNonce: (nonce: string) => setNonce(nonce) }));

function meta(content: string): HTMLMetaElement {
  const element = document.createElement('meta');
  element.name = 'csp-nonce';
  element.content = content;
  document.head.append(element);
  return element;
}

afterEach(() => {
  setNonce.mockReset();
  document.head.querySelectorAll('meta[name="csp-nonce"]').forEach((m) => m.remove());
});

describe('bootNonce', () => {
  it('calls setNonce with the content of the csp-nonce meta tag', async () => {
    const { bootNonce } = await import('@/lib/nonce');
    meta('AbCdEfGhIjKlMnOpQrSt_-');
    expect(bootNonce()).toBe('AbCdEfGhIjKlMnOpQrSt_-');
    expect(setNonce).toHaveBeenCalledExactlyOnceWith('AbCdEfGhIjKlMnOpQrSt_-');
  });

  it('does nothing without the tag, or with the placeholder of a page the server did not serve (Vite dev)', async () => {
    const { bootNonce } = await import('@/lib/nonce');
    expect(bootNonce()).toBeNull();
    meta('__CSP_NONCE__');
    expect(bootNonce()).toBeNull();
    expect(setNonce).not.toHaveBeenCalled();
  });
});
