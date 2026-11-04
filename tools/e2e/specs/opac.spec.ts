import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Locale } from '@altis/shared';
import type { CspRecorder } from '../lib/csp.js';
import { readAdminFixture } from '../lib/server.js';
import { tr } from '../lib/text.js';
import { T, expect, test } from '../fixtures.js';

// K10 (Phase 2 spec §15; plan Task 39): the OPAC a visitor sees, in a real browser, with the 1b CSP guard of
// fixtures.ts on every page: the home page, the results with their facets and feed, the record detail (cover,
// availability, shelf map, citations, structured data), a static page and the news, and the attachment viewers for a
// PDF, an audio and a video file, an image and a link. Each step is also checked on its own (`clean`), so that a
// violation names the step it happened in; the fixture checks the whole test once more.
//
// The catalogue is made once, before the tests, through the API as the fixture super admin (a request context of
// this file's own; uploads are multipart, which lib/api.ts's StaffApi does not send): a room with a floor plan and a
// shelf boxed on it, a public record with a cover, an item on that shelf and five public attachments, a menu page
// with an image and a news post with a cover. Every value carries a word of letters made for this run, so a search
// for it finds this record only.
//
// The files are made here, no tool and no download: a one-page PDF and a PNG written byte by byte, a WAV of 8-bit
// PCM, and a 32 × 24 VP8 WebM of two frames of one colour (525 bytes, encoded once with ffmpeg's libvpx from its own
// `color` source and kept below as base64). Chromium plays WAV and VP8 without proprietary codecs, so the audio and
// video players are required to load the files' metadata, not only to request them.
//
// The PDF viewer page is checked here (its "Buka PDF" and "Unduh" links, the file's sandboxed headers); that Chromium's
// own viewer renders the PDF in the new tab is opac-pdf.spec.ts (M10), which needs a full Chromium (Playwright's
// headless shell has no PDF viewer).
//
// The OPAC's own words live in apps/server/src/opac/catalog/messages (not a project tools/e2e references): the few
// this file looks for are written out below, with the key they come from. Words of the shared catalogues (`vocab.*`,
// `opac.*`) come from @altis/shared through lib/text.ts.

// ---------------------------------------------------------------------------------------------------------------
// The OPAC's words this spec reads (apps/server/src/opac/catalog/messages/*.ts).

const OPAC_TEXT = {
  id: {
    'shell.search.label': 'Cari di katalog',
    'search.count_one': 'Ditemukan 1 judul.',
    'search.feed.link': 'Ikuti hasil ini lewat RSS',
    'detail.availability': 'Ketersediaan',
    'detail.cite': 'Kutip judul ini',
    'detail.viewer.pdf_open': 'Buka PDF',
    'detail.viewer.download': 'Unduh',
    'detail.viewer.image_full': 'Lihat gambar ukuran penuh',
  },
  en: {
    'shell.search.label': 'Search the catalogue',
    'search.count_one': '1 title found.',
    'search.feed.link': 'Follow these results by RSS',
    'detail.availability': 'Availability',
    'detail.cite': 'Cite this title',
    'detail.viewer.pdf_open': 'Open PDF',
    'detail.viewer.download': 'Download',
    'detail.viewer.image_full': 'View the full-size image',
  },
} as const satisfies Record<Locale, Record<string, string>>;

type OpacTextKey = keyof (typeof OPAC_TEXT)['id'];

const O = (locale: Locale, key: OpacTextKey): string => OPAC_TEXT[locale][key];

// ---------------------------------------------------------------------------------------------------------------
// The files.

/** A one-page PDF 1.4 that says `text`, with a correct cross-reference table. */
function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
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

/** A PNG of `width` × `height` pixels of one RGB colour (8 bits, no filter, no metadata chunk). */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0, 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [...rgb]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A mono WAV of 8-bit PCM at 8 kHz: `ms` milliseconds of a 440 Hz tone. */
function toneWav(ms: number): Buffer {
  const rate = 8000;
  const samples = Math.round((rate * ms) / 1000);
  const data = Buffer.alloc(samples);
  for (let i = 0; i < samples; i += 1) data[i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // the fmt chunk's size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // bytes per second
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, data]);
}

/** A WebM (VP8, 32 × 24, 5 fps, two frames of #3366cc, 0.4 s): `ffmpeg -f lavfi -i color=c=0x3366cc:s=32x24:r=5:d=0.4 -c:v libvpx -b:v 8k -g 2 -an -fflags +bitexact -flags +bitexact -map_metadata -1 -f webm`. */
const TINY_WEBM = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTD' +
    'Z1OsggETTbuMU6uEHFO7a1OsggHH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEB5AAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgAAAAA' +
    'AAAAAZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgkLCBILqBGJqBAlWwhFW5gQESVMNn0HNzzWPAi2PFiAAAAAAAAAABZ8iYRaOHRU5DT0RFUkSH' +
    'i0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC40MDAwMDAwMDAAH0O2ddrngQCjvoEAAIDQAgCdASogABgAAEcIhYWIhYSIAgICdaoD+AII' +
    'IQg9AP75Ns//rzL68y+vMv+vMv/u837eb9vN/vyAo5WBAMgAsQEAARAQABgAGFgv9AAIcAAcU7trkbuPs4EAt4r3gQHxggFo8IED',
  'base64',
);

/** A valid ISBN-13 under the Indonesian prefix 978-602: six random digits, then the check digit. */
function randomIsbn13(): string {
  const digits = `978602${Array.from(randomBytes(6), (b) => String(b % 10)).join('')}`;
  const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${digits}${(10 - (sum % 10)) % 10}`;
}

/** A word of `n` random lower-case letters: one search token that no other spec writes. */
function randomLetters(n: number): string {
  return Array.from(randomBytes(n), (b) => String.fromCharCode(0x61 + (b % 26))).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// The API session that makes the catalogue.

/** The fixture super admin's API session: JSON with the CSRF token and Origin on writes, and multipart uploads. */
class CatalogApi {
  #csrf = '';

  private constructor(
    readonly ctx: APIRequestContext,
    private readonly origin: string,
  ) {}

  static async signIn(baseURL: string): Promise<CatalogApi> {
    const admin = readAdminFixture();
    const api = new CatalogApi(await playwrightRequest.newContext({ baseURL }), new URL(baseURL).origin);
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
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text.slice(0, 400)}`);
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    if (path === 'auth/me') this.#csrf = (body as { csrfToken: string }).csrfToken;
    return body;
  }

  json<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown): Promise<T> {
    return this.#send(method, path, data === undefined ? {} : { data }) as Promise<T>;
  }

  /** Uploads `bytes` into `context` (declare, one chunk, complete): the stored file's id. */
  async upload(context: string, bytes: Buffer, name: string): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const upload = await this.json<{ id: string; chunks: number }>('POST', 'files/uploads', { context, size: bytes.byteLength, sha256 });
    expect(upload.chunks).toBe(1);
    await this.#send('POST', `files/uploads/${upload.id}/chunks/0`, { multipart: { chunk: { name, mimeType: 'application/octet-stream', buffer: bytes } } });
    const done = await this.json<{ fileId?: string }>('POST', `files/uploads/${upload.id}/complete`, { originalName: name });
    if (done.fileId === undefined) throw new Error(`the ${context} upload did not store a file`);
    return done.fileId;
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The catalogue of this run.

interface Seeded {
  /** The word of this run (letters only), in the title, the agent, the subject, the page and the news. */
  word: string;
  record: { id: string; title: string; subtitle: string; isbn: string; callNumber: string; coverFileId: string };
  agentName: string;
  subjectTerm: string;
  item: { barcode: string };
  place: { room: string; shelf: string; planFileId: string };
  attachments: {
    pdf: { id: string; fileId: string; title: string; name: string };
    audio: { id: string; fileId: string; title: string };
    video: { id: string; fileId: string; title: string };
    image: { id: string; fileId: string; title: string };
    link: { id: string; title: string; url: string };
  };
  page: { slug: string; title: { id: string; en: string }; imageFileId: string };
  news: { slug: string; title: string; coverFileId: string };
}

function baseUrlOfRun(): string {
  const value = process.env['ALTIS_E2E_BASE_URL'];
  if (value === undefined || value === '') throw new Error('ALTIS_E2E_BASE_URL is not set: run the specs through tools/e2e/playwright.config.ts');
  return value;
}

async function seedCatalogue(api: CatalogApi): Promise<Seeded> {
  const word = randomLetters(6);
  const Word = word.charAt(0).toUpperCase() + word.slice(1);
  const tag = randomBytes(3).toString('hex').toUpperCase();

  const types = await api.json<{ items: { id: string; code: string }[] }>('GET', 'catalog/material-types');
  const buku = types.items.find((t) => t.code === 'BUKU');
  if (buku === undefined) throw new Error('the seeded material type BUKU is missing');
  // A fresh install names no default collection type (catalog.defaultCollectionTypeId is null): the seeded UMUM.
  const collectionTypes = await api.json<{ items: { id: string; code: string }[] }>('GET', 'catalog/collection-types');
  const umum = collectionTypes.items.find((t) => t.code === 'UMUM');
  if (umum === undefined) throw new Error('the seeded collection type UMUM is missing');
  const branches = await api.json<{ items: { id: string; isDefault: boolean }[] }>('GET', 'branches');
  const branch = branches.items.find((b) => b.isDefault);
  if (branch === undefined) throw new Error('the install has no default branch');

  // A public room with its floor plan, and a shelf boxed on it.
  const roomName = `Ruang Baca ${Word}`;
  const shelfName = `Rak Sastra ${Word}`;
  const room = await api.json<{ id: string; version: number }>('POST', `branches/${branch.id}/locations`, {
    parentId: null,
    kind: 'room',
    code: `R-${tag}`,
    name: roomName,
    isPublic: true,
    sortOrder: 0,
  });
  const planFileId = await api.upload('catalog.floor_plan', solidPng(40, 20, [0xee, 0xee, 0xdd]), 'denah.png');
  await api.json('PUT', `branches/${branch.id}/locations/${room.id}/map`, { floorPlanFileId: planFileId, version: room.version });
  const shelf = await api.json<{ id: string; version: number }>('POST', `branches/${branch.id}/locations`, {
    parentId: room.id,
    kind: 'shelf',
    code: `S-${tag}`,
    name: shelfName,
    classFrom: '800',
    classTo: '899',
    isPublic: true,
    sortOrder: 0,
  });
  await api.json('PUT', `branches/${branch.id}/locations/${shelf.id}/map`, { box: { x: 100, y: 200, w: 250, h: 300 }, version: shelf.version });

  // The record, its cover and an item on the shelf.
  const title = `Hikayat ${Word}`;
  const subtitle = 'Catatan Pelayaran';
  const isbn = randomIsbn13();
  const callNumber = `899.221 ${word.slice(0, 3).toUpperCase()}`;
  const agentName = `Sastrawan ${Word}`;
  const subjectTerm = `Pelayaran ${Word}`;
  const record = await api.json<{ id: string; version: number }>('POST', 'catalog/records', {
    materialTypeId: buku.id,
    title,
    subtitle,
    responsibility: agentName,
    publisher: { name: `Penerbit ${Word}`, place: 'Yogyakarta' },
    publicationPlace: 'Yogyakarta',
    publicationYear: '2024',
    classification: '899.221',
    callNumber,
    summary: `Kisah pelayaran ${word} dari Makassar ke Ternate.`,
    identifiers: [{ type: 'isbn', value: isbn }],
    agents: [{ ref: { type: 'person', name: agentName }, role: 'aut', isMain: true }],
    subjects: [{ ref: { type: 'topic', term: subjectTerm }, isPrimary: true }],
    opacVisible: true,
    promoted: true,
  });
  const coverFileId = await api.upload('catalog.cover', solidPng(12, 18, [0x33, 0x66, 0x99]), 'sampul.png');
  await api.json('PUT', `catalog/records/${record.id}/cover`, { fileId: coverFileId, version: record.version });
  const barcode = `OPAC-${tag}`;
  await api.json('POST', `branches/${branch.id}/items`, { recordId: record.id, barcode, collectionTypeId: umum.id, locationId: shelf.id });

  // Five public attachments: a PDF, a WAV, a WebM, a PNG and a link.
  const attach = async (fileId: string, attachmentTitle: string): Promise<{ id: string; fileId: string; title: string }> => {
    const a = await api.json<{ id: string }>('POST', `catalog/records/${record.id}/attachments`, { kind: 'file', fileId, title: attachmentTitle, access: 'public' });
    return { id: a.id, fileId, title: attachmentTitle };
  };
  const pdfName = `bab-${word}.pdf`;
  const pdf = { ...(await attach(await api.upload('catalog.attachment', onePagePdf(`Bab ${Word}`), pdfName), `Bab contoh ${Word}`)), name: pdfName };
  const audio = await attach(await api.upload('catalog.attachment', toneWav(600), `cuplikan-${word}.wav`), `Cuplikan suara ${Word}`);
  const video = await attach(await api.upload('catalog.attachment', TINY_WEBM, `cuplikan-${word}.webm`), `Cuplikan video ${Word}`);
  const image = await attach(await api.upload('catalog.attachment', solidPng(8, 8, [0xcc, 0x33, 0x33]), `peta-${word}.png`), `Peta pelayaran ${Word}`);
  const linkUrl = `https://penerbit.example/${word}`;
  const linkTitle = `Laman penerbit ${Word}`;
  const link = await api.json<{ id: string }>('POST', `catalog/records/${record.id}/attachments`, { kind: 'url', url: linkUrl, title: linkTitle, access: 'public' });

  // A menu page with an image in its body, in both languages, and a news post with a cover.
  const imageFileId = await api.upload('opac.page_image', solidPng(16, 10, [0x22, 0x88, 0x44]), 'gedung.png');
  const pageSlug = `tentang-${word}`;
  const pageTitle = { id: `Tentang ${Word}`, en: `About ${Word}` };
  await api.json('POST', 'opac/pages', {
    kind: 'page',
    slug: pageSlug,
    status: 'published',
    showInNav: true,
    sortOrder: 0,
    translations: {
      id: { title: pageTitle.id, bodyFormat: 'markdown', body: `Perpustakaan kami **buka setiap hari**.\n\n![Gedung perpustakaan](/files/${imageFileId})` },
      en: { title: pageTitle.en, bodyFormat: 'markdown', body: `Our library is **open every day**.\n\n![The library building](/files/${imageFileId})` },
    },
  });
  const newsCover = await api.upload('opac.page_image', solidPng(20, 12, [0x88, 0x44, 0x22]), 'sampul-berita.png');
  const newsSlug = `koleksi-${word}`;
  const newsTitle = `Koleksi baru ${Word}`;
  await api.json('POST', 'opac/pages', {
    kind: 'news',
    slug: newsSlug,
    status: 'published',
    showInNav: false,
    sortOrder: 0,
    coverFileId: newsCover,
    translations: { id: { title: newsTitle, summary: `Hikayat ${Word} kini ada di rak.`, bodyFormat: 'html', body: `<p>Judul <strong>${title}</strong> sudah dapat dipinjam.</p>` } },
  });

  return {
    word,
    record: { id: record.id, title, subtitle, isbn, callNumber, coverFileId },
    agentName,
    subjectTerm,
    item: { barcode },
    place: { room: roomName, shelf: shelfName, planFileId },
    attachments: { pdf, audio, video, image, link: { id: link.id, title: linkTitle, url: linkUrl } },
    page: { slug: pageSlug, title: pageTitle, imageFileId },
    news: { slug: newsSlug, title: newsTitle, coverFileId: newsCover },
  };
}

let seeded: Seeded | undefined;

/** The catalogue of this run (made in beforeAll). */
function data(): Seeded {
  if (seeded === undefined) throw new Error('the catalogue of this spec was not made (beforeAll failed)');
  return seeded;
}

test.beforeAll(async () => {
  const api = await CatalogApi.signIn(baseUrlOfRun());
  try {
    seeded = await seedCatalogue(api);
  } finally {
    await api.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers.

/** Runs `fn` as a reported step and requires that it caused no CSP problem (the fixture checks the test again). */
async function clean(csp: CspRecorder, name: string, fn: () => Promise<void>): Promise<void> {
  await test.step(name, async () => {
    const mark = csp.mark();
    await fn();
    expect(csp.problems(mark), `CSP problems during "${name}"`).toEqual([]);
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The record's canonical path pattern (`/katalog/<id>/<slug>`, the language kept). */
const recordPathPattern = (id: string, lang = ''): RegExp => new RegExp(`/katalog/${id}/[a-z0-9-]+${escapeRegExp(lang)}$`);

/** Waits until every `<img>` of `scope` has loaded a picture (a blocked or broken one keeps naturalWidth 0). */
async function expectImagesLoaded(scope: Locator, what: string): Promise<void> {
  const images = scope.locator('img');
  const n = await images.count();
  expect(n, `${what}: images`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    const img = images.nth(i);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { message: `${what}: image ${i + 1} loads` }).toBeGreaterThan(0);
  }
}

/** The status of the first GET of `path` this page sees from now on (a media file a player asks for). */
function responseOf(page: Page, path: string): Promise<number> {
  return page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'GET').then((r) => r.status());
}

// ---------------------------------------------------------------------------------------------------------------
// The tests, in the order a visitor goes.

test('home: the new and featured titles with their covers, the news, the classes and the menu, in both languages', async ({ page, csp }) => {
  const d = data();
  for (const locale of ['id', 'en'] as const) {
    await clean(csp, `home (${locale})`, async () => {
      const res = await page.goto(`/?lang=${locale}`);
      expect(res?.status()).toBe(200);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1, name: 'Perpustakaan E2E' })).toBeVisible();

      for (const section of ['judul-baru', 'judul-unggulan']) {
        const titles = page.locator(`section[aria-labelledby="${section}"]`);
        const card = titles.locator('li.card').filter({ has: page.locator(`a[href^="/katalog/${d.record.id}/"]`) });
        await expect(card, `${section} lists the record`).toHaveCount(1);
        await expect(card.locator('a.card-title')).toHaveAttribute('href', recordPathPattern(d.record.id, `?lang=${locale}`));
        await expect(card.locator('img.card-cover')).toHaveAttribute('src', `/files/${d.record.coverFileId}`);
        await expectImagesLoaded(card, `${section} cover`);
      }

      const news = page.locator('section[aria-labelledby="berita-terbaru"]');
      await expect(news.getByRole('link', { name: d.news.title, exact: true })).toHaveAttribute('href', `/berita/${d.news.slug}?lang=${locale}`);
      await expect(page.locator('section[aria-labelledby="jelajah-kelas"] a[href^="/cari?kelas="]')).toHaveCount(10);

      const menu = page.getByRole('navigation').filter({ has: page.locator(`a[href^="/halaman/${d.page.slug}"]`) });
      await expect(menu.getByRole('link', { name: d.page.title[locale], exact: true })).toHaveAttribute('href', `/halaman/${d.page.slug}?lang=${locale}`);

      // The structured data parses: Library and WebSite with its search action.
      const types = (await page.locator('script[type="application/ld+json"]').allTextContents()).flatMap((text) => {
        const value = JSON.parse(text) as { '@type'?: unknown; '@graph'?: { '@type'?: unknown }[] };
        return [value['@type'], ...(value['@graph'] ?? []).map((g) => g['@type'])].filter((t) => t !== undefined);
      });
      expect(types).toEqual(expect.arrayContaining(['Library', 'WebSite']));
    });
  }
});

test('results: the home search finds the record; its card, the facets, a facet that narrows and the feed', async ({ page, csp, baseURL }) => {
  const d = data();
  await clean(csp, 'search from the home page', async () => {
    await page.goto('/');
    const form = page.locator('main').getByRole('search');
    await form.getByLabel(O('id', 'shell.search.label'), { exact: true }).fill(d.word);
    await form.getByLabel(O('id', 'shell.search.label'), { exact: true }).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/cari\\?q=${d.word}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    await expect(page.locator('p.search-count')).toContainText(O('id', 'search.count_one'));
  });

  const card = page.locator('li.card').filter({ has: page.locator(`a[href^="/katalog/${d.record.id}/"]`) });
  await clean(csp, 'the result card', async () => {
    await expect(page.locator('li.card')).toHaveCount(1);
    await expect(card.locator('a.card-title')).toContainText(d.record.title);
    await expect(card).toContainText(d.agentName);
    await expect(card.locator('.status-ok')).toBeVisible();
    await expectImagesLoaded(card, 'the result cover');
  });

  await clean(csp, 'the facets: the material type narrows, the active filter removes it', async () => {
    const facets = page.locator('aside#saring');
    await expect(facets.locator('section.facet').first()).toBeVisible();
    const type = facets.locator('a[href*="jenis=BUKU"]').first();
    // The seeded material type's Indonesian name (0027_catalog_seed).
    await expect(type).toContainText('Buku');
    await type.click();
    await expect(page).toHaveURL(/[?&]jenis=BUKU(&|$)/);
    await expect(page.locator('li.card')).toHaveCount(1);
    const active = page.locator('section.filters-active');
    await expect(active).toBeVisible();
    await active.locator('a').first().click();
    await expect(page).not.toHaveURL(/jenis=/);
    await expect(page.locator('li.card')).toHaveCount(1);
  });

  await clean(csp, 'the results in English keep the language on every link', async () => {
    await page.goto(`/cari?q=${d.word}&lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('p.search-count')).toContainText(O('en', 'search.count_one'));
    await expect(card.locator('a.card-title')).toHaveAttribute('href', recordPathPattern(d.record.id, '?lang=en'));
  });

  await clean(csp, 'the results feed (RSS) holds the record at an absolute URL', async () => {
    await page.goto(`/cari?q=${d.word}`);
    const feed = page.getByRole('link', { name: O('id', 'search.feed.link'), exact: true });
    const href = await feed.getAttribute('href');
    expect(href).toMatch(/^\/cari\/rss\?q=/);
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml /);
    expect(xml).toContain('<rss');
    expect(xml).toMatch(new RegExp(`<link>${escapeRegExp(baseURL!)}/katalog/${d.record.id}/[a-z0-9-]+</link>`));
    const newest = await page.request.get('/rss');
    expect(await newest.text()).toContain(`${baseURL!}/katalog/${d.record.id}/`);
  });
});

test('detail: cover, agents, subjects, availability on the shelf map, citations and structured data; the bare record URL redirects', async ({ page, csp, baseURL }) => {
  const d = data();
  // Every answer for the floor plan, from the first visit on. The plan is a lazy <img> under the map's SVG (Task 39e
  // finding 1: Chromium fetched an SVG <image> at page load with its <details> closed), so nothing may ask for it
  // before the map is opened, and it answers 200 once it is.
  const planStatuses: number[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === `/files/${d.place.planFileId}`) planStatuses.push(r.status());
  });

  await clean(csp, 'the bare record URL answers 301 to the canonical one', async () => {
    const res = await page.request.get(`/katalog/${d.record.id}`, { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toMatch(new RegExp(`^/katalog/${d.record.id}/[a-z0-9-]+$`));
    await page.goto(`/katalog/${d.record.id}`);
    await expect(page).toHaveURL(recordPathPattern(d.record.id));
  });

  const main = page.locator('main');
  await clean(csp, 'the heading, the cover and the bibliographic description', async () => {
    await expect(main.getByRole('heading', { level: 1 })).toContainText(d.record.title);
    await expect(main.getByRole('heading', { level: 1 })).toContainText(d.record.subtitle);
    await expect(main.locator('img.record-cover')).toHaveAttribute('src', `/files/${d.record.coverFileId}`);
    await expectImagesLoaded(main.locator('header.record-header'), 'the cover');
    await expect(main.locator('section[aria-labelledby="deskripsi"]')).toContainText(d.record.isbn);
    await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`^${escapeRegExp(baseURL!)}/katalog/${d.record.id}/[a-z0-9-]+$`));
  });

  await clean(csp, 'the structured data: a Book with its ISBN', async () => {
    const values = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((text) => JSON.parse(text) as Record<string, unknown>);
    const book = values.flatMap((v) => [v, ...((v['@graph'] as Record<string, unknown>[] | undefined) ?? [])]).find((v) => v['@type'] === 'Book');
    expect(book, 'a JSON-LD Book').toBeDefined();
    expect(JSON.stringify(book!['isbn'])).toContain(d.record.isbn);
  });

  await clean(csp, 'availability: the item on its shelf, available; the shelf map loads its floor plan', async () => {
    const availability = main.locator('section[aria-labelledby="ketersediaan"]');
    await expect(availability.getByRole('heading', { level: 2 })).toHaveText(O('id', 'detail.availability'));
    const row = availability.locator('tbody tr').filter({ hasText: d.item.barcode });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(d.place.room);
    await expect(row).toContainText(d.place.shelf);
    await expect(row).toContainText(d.record.callNumber);
    await expect(row).toContainText(T('vocab.item_status.available'));

    const map = availability.locator('details.shelf-map');
    await expect(map).toHaveCount(1);
    const svg = map.locator('svg[role="img"]');
    await expect(svg).toHaveAttribute('aria-label', new RegExp(escapeRegExp(d.place.shelf)));
    expect(planStatuses, 'the floor plan is not fetched before the map is opened').toEqual([]);
    await map.locator('summary').click();
    await expect(svg).toBeVisible();
    await expect(map.locator('.shelf-map-plan img')).toHaveAttribute('src', `/files/${d.place.planFileId}`);
    await expect.poll(() => planStatuses, { message: 'the floor plan is fetched' }).toContain(200);
    await expectImagesLoaded(map, 'the floor plan');
  });

  await clean(csp, 'the agent and the subject lead to their searches, which find the record', async () => {
    await main.getByRole('link', { name: d.agentName, exact: true }).click();
    await expect(page).toHaveURL(/\/cari\?pengarang=[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.locator(`li.card a[href^="/katalog/${d.record.id}/"]`)).toHaveCount(1);
    await page.goBack();
    await main.getByRole('link', { name: d.subjectTerm, exact: true }).click();
    await expect(page).toHaveURL(/\/cari\?subjek=[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(page.locator(`li.card a[href^="/katalog/${d.record.id}/"]`)).toHaveCount(1);
    await page.goBack();
    await expect(page).toHaveURL(recordPathPattern(d.record.id));
  });

  await clean(csp, 'the citations open; RIS and BibTeX download the record', async () => {
    const cite = main.locator('details.citations');
    await cite.locator('summary').click();
    await expect(cite.getByRole('heading', { name: O('id', 'detail.cite'), exact: true })).toBeVisible();
    await expect(cite).toContainText(d.record.title);
    for (const format of ['ris', 'bibtex'] as const) {
      const href = await cite.locator(`a[href^="/katalog/${d.record.id}/${format}"]`).getAttribute('href');
      expect(href).not.toBeNull();
      const res = await page.request.get(href!);
      expect(res.status(), `${format} download`).toBe(200);
      expect(res.headers()['content-disposition']).toMatch(/^attachment/);
      expect(await res.text()).toContain(d.record.title);
    }
  });

  await clean(csp, 'the record in English', async () => {
    await page.goto(`/katalog/${d.record.id}?lang=en`);
    await expect(page).toHaveURL(recordPathPattern(d.record.id, '?lang=en'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(main.locator('section[aria-labelledby="ketersediaan"] h2')).toHaveText(O('en', 'detail.availability'));
    await expect(main.locator('section[aria-labelledby="ketersediaan"] tbody tr').filter({ hasText: d.item.barcode })).toContainText(tr('en', 'vocab.item_status.available'));
  });

  await clean(csp, 'an unknown record is the OPAC 404 page', async () => {
    const res = await page.goto('/katalog/01J00000000000000000000000');
    expect(res?.status()).toBe(404);
    await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    await expect(page.getByRole('navigation', { name: tr('id', 'opac.lang.switch') })).toBeVisible();
  });
});

test('viewers: the PDF, audio, video, image and link attachments, each opened from the record', async ({ page, csp }) => {
  const d = data();
  const a = d.attachments;
  const viewerPath = (aid: string): string => `/katalog/${d.record.id}/lampiran/${aid}`;

  /** From the record page, the attachment's link in "Lampiran", then its viewer. */
  const open = async (title: string, aid: string): Promise<void> => {
    await page.goto(`/katalog/${d.record.id}`);
    const list = page.locator('main ul.attachment-list');
    await list.getByRole('link', { name: title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(viewerPath(aid))}$`));
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  };

  await clean(csp, 'the record lists its five attachments', async () => {
    await page.goto(`/katalog/${d.record.id}`);
    const list = page.locator('main ul.attachment-list');
    for (const x of [a.pdf, a.audio, a.video, a.image, a.link]) {
      await expect(list.getByRole('link', { name: x.title, exact: true })).toHaveAttribute('href', viewerPath(x.id));
    }
  });

  await clean(csp, 'PDF: "Buka PDF" in a new tab and "Unduh", the file served sandboxed and inline', async () => {
    await open(a.pdf.title, a.pdf.id);
    await expect(page.locator('main .viewer-kind')).toHaveText(T('vocab.attachment_media.pdf'));
    const openLink = page.getByRole('link', { name: O('id', 'detail.viewer.pdf_open'), exact: true });
    await expect(openLink).toHaveAttribute('href', `/files/${a.pdf.fileId}`);
    await expect(openLink).toHaveAttribute('target', '_blank');
    await expect(openLink).toHaveAttribute('rel', /noopener/);
    await expect(page.getByRole('link', { name: O('id', 'detail.viewer.download'), exact: true })).toHaveAttribute('download', a.pdf.name);
    const head = await page.request.fetch(`/files/${a.pdf.fileId}`, { method: 'HEAD' });
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toBe('application/pdf');
    expect(head.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(head.headers()['content-disposition']).toMatch(/^inline/);
    expect(head.headers()['x-content-type-options']).toBe('nosniff');
  });

  for (const kind of ['audio', 'video'] as const) {
    const x = a[kind];
    await clean(csp, `${kind}: the player loads the file's metadata from /files`, async () => {
      const fetched = responseOf(page, `/files/${x.fileId}`);
      await open(x.title, x.id);
      await expect(page.locator('main .viewer-kind')).toHaveText(T(`vocab.attachment_media.${kind}`));
      const player = page.locator(`main ${kind}.viewer-media`);
      await expect(player).toHaveAttribute('src', `/files/${x.fileId}`);
      await expect(player).toHaveAttribute('controls', '');
      expect([200, 206], `${kind}: /files answered`).toContain(await fetched);
      await expect
        .poll(() => player.evaluate((el: HTMLMediaElement) => ({ ready: el.readyState >= 1, error: el.error?.code ?? null })), {
          message: `${kind}: HAVE_METADATA without a media error`,
          timeout: 20_000,
        })
        .toEqual({ ready: true, error: null });
      expect(await player.evaluate((el: HTMLMediaElement) => el.duration)).toBeGreaterThan(0);
      if (kind === 'video') expect(await player.evaluate((el: HTMLVideoElement) => [el.videoWidth, el.videoHeight])).toEqual([32, 24]);
      await expect(page.getByRole('link', { name: new RegExp(`^${escapeRegExp(O('id', 'detail.viewer.download'))} \\(`) })).toHaveAttribute('href', `/files/${x.fileId}`);
    });
  }

  await clean(csp, 'image: the picture and its full-size link', async () => {
    await open(a.image.title, a.image.id);
    const figure = page.locator('main figure.viewer-image');
    await expect(figure.locator('img')).toHaveAttribute('src', `/files/${a.image.fileId}`);
    await expectImagesLoaded(figure, 'the image attachment');
    expect(await figure.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(8);
    await expect(figure.getByRole('link', { name: O('id', 'detail.viewer.image_full'), exact: true })).toHaveAttribute('href', `/files/${a.image.fileId}`);
  });

  await clean(csp, 'link: the leaving notice, then the link (noopener nofollow)', async () => {
    await open(a.link.title, a.link.id);
    const notice = page.locator('main .leaving[role="note"]');
    await expect(notice).toContainText(a.link.url);
    const go = notice.getByRole('link');
    await expect(go).toHaveAttribute('href', a.link.url);
    await expect(go).toHaveAttribute('rel', 'noopener nofollow');
    await expect(go).toContainText('penerbit.example');
  });

  await clean(csp, 'the viewers in English', async () => {
    await page.goto(`${viewerPath(a.video.id)}?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('main .viewer-kind')).toHaveText(tr('en', 'vocab.attachment_media.video'));
    await page.goto(`${viewerPath(a.pdf.id)}?lang=en`);
    await expect(page.getByRole('link', { name: O('en', 'detail.viewer.pdf_open'), exact: true })).toHaveAttribute('href', `/files/${a.pdf.fileId}`);
  });
});

test('page and news: the menu page with its image, the news list, the post with its cover, and the news feed', async ({ page, csp, baseURL }) => {
  const d = data();
  await clean(csp, 'the menu page from the home page, its body image loads', async () => {
    await page.goto('/');
    await page.getByRole('link', { name: d.page.title.id, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/halaman/${d.page.slug}$`));
    const article = page.locator('main article.page-article');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText(d.page.title.id);
    await expect(article.locator('.page-body strong')).toHaveText('buka setiap hari');
    await expect(article.locator('.page-body img')).toHaveAttribute('src', `/files/${d.page.imageFileId}`);
    await expect(article.locator('.page-body img')).toHaveAttribute('alt', 'Gedung perpustakaan');
    await expectImagesLoaded(article.locator('.page-body'), 'the page image');
  });

  await clean(csp, 'the menu page in English', async () => {
    await page.goto(`/halaman/${d.page.slug}?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('main article.page-article h1')).toHaveText(d.page.title.en);
    await expect(page.locator('main article.page-article .page-body strong')).toHaveText('open every day');
  });

  await clean(csp, 'the news list, then the post with its cover', async () => {
    await page.goto('/berita');
    await page.locator('main ol.news-index').getByRole('link', { name: d.news.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/berita/${d.news.slug}$`));
    const article = page.locator('main article.page-article');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText(d.news.title);
    await expect(article.locator('.page-body strong')).toHaveText(d.record.title);
    await expect(article.locator('img.page-cover')).toHaveAttribute('src', `/files/${d.news.coverFileId}`);
    await expectImagesLoaded(article, 'the news cover');
  });

  await clean(csp, 'the news post shown in English falls back to Indonesian, marked as such', async () => {
    await page.goto(`/berita/${d.news.slug}?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('main article.page-article')).toHaveAttribute('lang', 'id');
    await expect(page.locator('main article.page-article h1')).toHaveText(d.news.title);
  });

  await clean(csp, 'the news feed holds the post at an absolute URL', async () => {
    const res = await page.request.get('/berita/rss');
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<rss');
    expect(xml).toContain(`<link>${baseURL!}/berita/${d.news.slug}</link>`);
  });
});

test('crawlers: robots.txt names the sitemap, and the sitemaps list the record and the page', async ({ page, baseURL }) => {
  const d = data();
  const robots = await page.request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).toContain('Disallow: /admin');
  expect(text).toContain(`Sitemap: ${baseURL!}/sitemap.xml`);
  const index = await (await page.request.get('/sitemap.xml')).text();
  expect(index).toContain(`<loc>${baseURL!}/sitemap/katalog/1</loc>`);
  expect(index).toContain(`<loc>${baseURL!}/sitemap/halaman</loc>`);
  const catalogue = await (await page.request.get('/sitemap/katalog/1')).text();
  expect(catalogue).toMatch(new RegExp(`<loc>${escapeRegExp(baseURL!)}/katalog/${d.record.id}/[a-z0-9-]+</loc>`));
  const pages = await (await page.request.get('/sitemap/halaman')).text();
  expect(pages).toContain(`<loc>${baseURL!}/halaman/${d.page.slug}</loc>`);
  expect(pages).toContain(`<loc>${baseURL!}/berita/${d.news.slug}</loc>`);
});
