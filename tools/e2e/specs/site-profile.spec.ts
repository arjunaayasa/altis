import { crc32, deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { openNavPage } from '../lib/nav.js';
import { readAdminFixture } from '../lib/server.js';
import { T, expect, signIn, test } from '../fixtures.js';

// The library's profile site as its staff set it up, in a real browser and under the CSP guard of fixtures.ts:
//
// - Situs / OPAC › Halaman awal › Slider hero: two slides are added in the admin (a photo chosen, cut and uploaded, its
//   alternative text, a title), the page is saved, and the public home page shows both. The slides change by
//   themselves, and the pause button stops them.
// - Situs / OPAC › Identitas situs: an SVG is refused with the advice to export a PNG; a PNG is taken, saved, and then
//   stands in the header of the public site and in the admin's sidebar. The logo is taken off again at the end, so the
//   specs that follow meet the install as they expect it.
//
// The files are made here, byte by byte: a grey baseline JPEG and an RGB PNG.

/** A grey baseline JPEG of `width` × `height`: one component, every block a DC difference of zero and nothing else. */
function greyJpeg(width: number, height: number): Buffer {
  const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
  const table = (id: number): number[] => [0xff, 0xc4, 0x00, 0x14, id, 1, ...new Array<number>(15).fill(0), 0x00];
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const scan = Buffer.alloc(Math.ceil(bits / 8));
  if (bits % 8 !== 0) scan[scan.length - 1] = 0xff >> (bits % 8);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, ...u16(height), ...u16(width), 0x01, 0x01, 0x11, 0x00]),
    Buffer.from(table(0x00)),
    Buffer.from(table(0x10)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** An RGB PNG of `width` × `height` in one colour. */
function plainPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))]);
  const raw = Buffer.concat(new Array<Buffer>(height).fill(row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The public site's words this spec reads (apps/server/src/opac/catalog/messages/home.ts).
const HERO_PAUSE = 'Jeda pergantian slide';
const HERO_PLAY = 'Putar pergantian slide';

/** The label of a field that is asked once per language, as the editor prints it. */
const inIndonesian = (label: string): string => `${label} (${T('opacHome.lang.id')})`;

/** Every image under `scope` has arrived and has pixels. */
async function expectLoaded(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() => page.locator(selector).evaluateAll((imgs) => imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
}

test('slides added in the admin show on the public home page, change by themselves and stop at the pause button', async ({ page }) => {
  const word = `geser${Date.now().toString(36)}`;
  const titles = [`Ruang baca ${word}`, `Lomba mendongeng ${word}`];
  await signIn(page, readAdminFixture());
  await openNavPage(page, '/admin/opac/beranda');
  await expect(page).toHaveURL(/\/admin\/opac\/beranda\/slider$/);

  for (const [i, title] of titles.entries()) {
    await page.getByRole('button', { name: T('opacHome.slides.add'), exact: true }).click();
    const drawer = page.getByRole('dialog', { name: T('opacHome.slide.new') });
    // A photo is used once on the page: each slide brings a file of its own size.
    await drawer.getByLabel(T('opacHome.photo.upload'), { exact: true }).setInputFiles({ name: `slide-${i + 1}.jpg`, mimeType: 'image/jpeg', buffer: greyJpeg(1600 + i * 16, 900 + i * 9) });
    await drawer.getByRole('button', { name: T('opacHome.crop.use'), exact: true }).click();
    await expect(drawer.getByLabel(T('opacHome.photo.replace'), { exact: true })).toBeAttached({ timeout: 30_000 });
    await drawer.getByLabel(T('opacHome.slide.alt'), { exact: true }).fill(`Foto ${title}`);
    await drawer.getByLabel(inIndonesian(T('opacHome.slide.title')), { exact: true }).fill(title);
    await drawer.getByRole('button', { name: T('opacHome.slide.done'), exact: true }).click();
    await expect(drawer).toBeHidden();
  }
  await page.getByRole('button', { name: T('opacHome.save'), exact: true }).click();
  await expect(page.getByText(T('opacHome.saved'))).toBeVisible();

  await page.goto('/');
  const hero = page.locator('.hero');
  for (const title of titles) await expect(hero.locator('.slide', { hasText: title })).toHaveCount(1);
  await expectLoaded(page, '.hero .slide.is-on img');
  // Away from the hero (a pointer over it holds the slides), the slide on top gives way to the next one by itself.
  await page.mouse.move(2, 2);
  const onTop = (): Promise<string | null> => hero.locator('.slide.is-on').first().getAttribute('id');
  const first = await onTop();
  expect(first).not.toBeNull();
  await expect.poll(onTop, { timeout: 20_000 }).not.toBe(first);

  // Paused, it stays: longer than the longest interval the setting takes.
  const pause = hero.locator('[data-pause]');
  await expect(pause).toHaveAttribute('aria-label', HERO_PAUSE);
  await pause.click();
  await expect(pause).toHaveAttribute('aria-label', HERO_PLAY);
  await page.mouse.move(2, 2);
  const held = await onTop();
  await page.waitForTimeout(11_000);
  expect(await onTop()).toBe(held);
});

test('an SVG logo is refused; a PNG logo is saved and stands on the public site and in the sidebar', async ({ page }) => {
  await signIn(page, readAdminFixture());
  await openNavPage(page, '/admin/opac/identitas');
  await expect(page.getByRole('heading', { level: 1, name: T('siteIdentity.title'), exact: true })).toBeVisible();
  const upload = page.getByLabel(T('siteIdentity.logo.upload'), { exact: true });

  await upload.setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect width="320" height="80"/></svg>') });
  await expect(page.getByText(T('siteIdentity.image.svg'))).toBeVisible();
  // An SVG that calls itself a PNG is told by its content.
  await upload.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"></svg>') });
  await expect(page.getByText(T('siteIdentity.image.svg'))).toBeVisible();
  await expect(page.getByText(T('siteIdentity.logo.empty'))).toBeVisible();

  await upload.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: plainPng(320, 80, [23, 98, 79]) });
  await expect(page.getByAltText(T('siteIdentity.logo.preview_alt'), { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: T('siteIdentity.save'), exact: true }).click();
  await expect(page.getByText(T('siteIdentity.saved'))).toBeVisible();

  // The sidebar takes the saved logo (a file of the server now, no longer the browser's own copy).
  const sidebarLogo = page.locator('[data-slot="sidebar"] img[src^="/files/"]');
  await expect(sidebarLogo).toBeVisible();
  await expectLoaded(page, '[data-slot="sidebar"] img[src^="/files/"]');
  const src = await sidebarLogo.getAttribute('src');

  await page.goto('/');
  await expect(page.locator(`header .sitelogo img[src="${src}"]`)).toBeVisible();
  await expectLoaded(page, 'header .sitelogo img');

  // Back to a site without a logo: its name stands as text again.
  await page.goto('/admin/opac/identitas');
  await page.getByRole('button', { name: T('siteIdentity.logo.remove'), exact: true }).click();
  await page.getByRole('button', { name: T('siteIdentity.save'), exact: true }).click();
  await expect(page.getByText(T('siteIdentity.saved'))).toBeVisible();
  await page.goto('/');
  await expect(page.locator('header .sitelogo img')).toHaveCount(0);
});
