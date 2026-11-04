import { createHash } from 'node:crypto';
import type { APIRequestContext, Frame, Page } from '@playwright/test';
import type { AdminFixture } from '../lib/server.js';
import { expect, test } from '../fixtures.js';

// M10 (Phase 2 Task 34; spec §9.8): `/files/:id` sends every file with `Content-Security-Policy: default-src 'none';
// sandbox`, and Chromium's own PDF viewer has been known to refuse a sandboxed document. The OPAC's attachment viewer
// offers "Buka PDF" (a new tab with that viewer; pdf.js waits for the owner, P1) and "Unduh". This spec opens a public
// PDF attachment's viewer, clicks "Buka PDF" and requires that Chromium's viewer renders the document's page in the new
// tab (its page selector counts the pages once the plug-in has loaded the PDF; a broken or refused document counts 0).
// If it ever fails, the plan's fallback applies: serve `application/pdf` without `sandbox` (keeping `default-src
// 'none'` and nosniff) or offer "Unduh" alone.
//
// Chromium only shows PDFs in the full browser (new headless included); Playwright's headless shell has no PDF viewer
// (its new tab stays empty or downloads the file), so this spec fails there by design.
// Without ALTIS_E2E_EXECUTABLE or ALTIS_E2E_CHANNEL the spec asks Playwright for its full Chromium (`channel:
// 'chromium'`); an executable given must be a full Chromium-based browser, not a headless shell. Run alone:
//
//   pnpm e2e --grep pdf
//
// The record, the upload and the attachment are made through the API as the fixture super admin, in a request context
// of this spec's own (the upload's chunk is multipart, which lib/api.ts's StaffApi does not send).

const fullBrowserGiven = (process.env['ALTIS_E2E_EXECUTABLE']?.trim() ?? '') !== '' || (process.env['ALTIS_E2E_CHANNEL']?.trim() ?? '') !== '';
test.use(fullBrowserGiven ? {} : { channel: 'chromium' });

/** A one-page PDF 1.4 that says "Halo PDF", with a correct cross-reference table (written here, no tool). */
function onePagePdf(): Buffer {
  const stream = 'BT /F1 24 Tf 40 100 Td (Halo PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The admin's API session: JSON calls with the CSRF token and Origin on writes, and the upload's multipart chunk. */
class CatalogApi {
  #csrf = '';

  private constructor(
    private readonly ctx: APIRequestContext,
    private readonly origin: string,
  ) {}

  static async signIn(ctx: APIRequestContext, baseURL: string, admin: AdminFixture): Promise<CatalogApi> {
    const api = new CatalogApi(ctx, new URL(baseURL).origin);
    await api.json('GET', 'auth/me');
    await api.json('POST', 'auth/login', { username: admin.username, password: admin.password });
    await api.json('GET', 'auth/me');
    return api;
  }

  async #send(method: string, path: string, o: { data?: unknown; multipart?: Record<string, { name: string; mimeType: string; buffer: Buffer }> }): Promise<unknown> {
    const write = method !== 'GET';
    const res = await this.ctx.fetch(`/api/v1/${path}`, {
      method,
      headers: { accept: 'application/json', ...(write ? { 'x-csrf-token': this.#csrf, origin: this.origin } : {}) },
      ...o,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const token = res.headers()['x-csrf-token'];
    if (token !== undefined && token !== '') this.#csrf = token;
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text.slice(0, 300)}`);
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    if (path === 'auth/me') this.#csrf = (body as { csrfToken: string }).csrfToken;
    return body;
  }

  json<T>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
    return this.#send(method, path, data === undefined ? {} : { data }) as Promise<T>;
  }

  /** Uploads `bytes` into the `catalog.attachment` context: declare, one chunk, complete; the stored file's id. */
  async uploadAttachmentFile(bytes: Buffer, name: string): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await this.json<{ id: string; chunks: number }>('POST', 'files/uploads', { context: 'catalog.attachment', size: bytes.byteLength, sha256 });
    expect(upload.chunks).toBe(1);
    await this.#send('POST', `files/uploads/${upload.id}/chunks/0`, { multipart: { chunk: { name, mimeType: 'application/octet-stream', buffer: bytes } } });
    const done = await this.json<{ fileId?: string }>('POST', `files/uploads/${upload.id}/complete`, { originalName: name });
    if (done.fileId === undefined) throw new Error('the catalog.attachment upload did not store a file');
    return done.fileId;
  }
}

/** The pages Chromium's PDF viewer in `popup` says the document has (0 while loading, for a refused or broken one). */
async function viewerPageCount(popup: Page): Promise<number> {
  const viewer: Frame | undefined = popup.frames().find((f) => f.url().startsWith('chrome-extension://'));
  if (viewer === undefined) return 0;
  return viewer
    .evaluate(() => {
      // The page selector sits in nested shadow roots of the viewer's elements.
      const find = (root: Document | ShadowRoot): number | null => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.tagName.toLowerCase() === 'viewer-page-selector') return Number((el as unknown as { docLength?: unknown }).docLength ?? 0);
          if (el.shadowRoot !== null) {
            const n = find(el.shadowRoot);
            if (n !== null) return n;
          }
        }
        return null;
      };
      return find(document) ?? 0;
    })
    .catch(() => 0);
}

test('M10: "Buka PDF" opens a public PDF attachment in Chromium\'s own viewer, which renders its page despite the sandbox CSP', async ({
  page,
  context,
  playwright,
  baseURL,
  admin,
}) => {
  const ctx = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    const api = await CatalogApi.signIn(ctx, baseURL!, admin);
    const types = await api.json<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
    const buku = types.items.find((t) => t.code === 'BUKU');
    if (buku === undefined) throw new Error('the seeded material type BUKU is missing');
    const record = await api.json<{ id: string }>('POST', 'catalog/records', { materialTypeId: buku.id, title: 'Uji penampil PDF' });
    const pdf = onePagePdf();
    const fileId = await api.uploadAttachmentFile(pdf, 'uji-penampil.pdf');
    const attachment = await api.json<{ id: string }>('POST', `catalog/records/${record.id}/attachments`, { kind: 'file', fileId, title: 'Bab contoh', access: 'public' });

    // The condition M10 is about: the file is served sandboxed, as a PDF, inline.
    const head = await ctx.fetch(`/files/${fileId}`, { method: 'HEAD', failOnStatusCode: false });
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toBe('application/pdf');
    expect(head.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(head.headers()['content-disposition']).toMatch(/^inline/);

    await page.goto(`/katalog/${record.id}/lampiran/${attachment.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Bab contoh' })).toBeVisible();
    const open = page.getByRole('link', { name: 'Buka PDF', exact: true });
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: 'Unduh', exact: true })).toHaveAttribute('download', 'uji-penampil.pdf');

    // A browser without a PDF viewer turns the new tab's navigation into a download, and that tab never fires `load`:
    // the download is watched from the moment the tab exists, and the poll (not a load wait) decides.
    let downloaded = false;
    context.on('page', (p) =>
      p.on('download', () => {
        downloaded = true;
      }),
    );
    const [popup] = await Promise.all([context.waitForEvent('page'), open.click()]);
    await expect
      .poll(async () => (downloaded ? -1 : viewerPageCount(popup)), {
        message:
          'the PDF viewer renders 1 page (0: no viewer showed it: Chromium refused the sandboxed PDF, or the browser has no PDF viewer, ' +
          'as a headless shell; -1: the browser downloaded it; for 0 or -1 with a full Chromium, apply the M10 fallback)',
        timeout: 30_000,
      })
      .toBe(1);
    expect(new URL(popup.url()).pathname).toBe(`/files/${fileId}`);
  } finally {
    await ctx.dispose();
  }
});
