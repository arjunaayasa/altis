import { createHash } from 'node:crypto';
import { readBytes, uploadPath } from '@altis/platform';
import { withTx } from '@altis/db';
import { DomainError, isDomainError, newId } from '@altis/shared';
import { SITE_IDENTITY_DEFAULT, type SiteIdentity } from '@altis/shared/api/site-identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { txCtx } from '../../src/context.js';
import { uploadContext } from '../../src/files/contexts.js';
import { decodePng, pngHeader } from '../../src/files/png.js';
import { acceptChunk, completeUpload, createUpload, uploadOwner } from '../../src/files/uploads.js';
import { readOpacHome, saveOpacHome } from '../../src/opac-home/content.js';
import { publicSiteIdentity, readSiteIdentity, saveSiteIdentity, siteIconPng } from '../../src/opac-home/site-identity.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import { PNG_SIGNATURE, chunkTypes, gradientPng, handPng, ihdr, pngChunk, solidPng } from '../fixtures/png.js';
import { KEYRING, openExportDb, type ExportDb } from './reports-export-support.js';

// The site identity (core): the logo and icon uploads, which the server decodes and stores again (so a file that only
// claims to be a PNG, an SVG, a damaged or oversized image never becomes a stored file, and a stored one holds nothing
// but its picture), and the setting: read from the home page's old logo until it is saved, saved with a revision, its
// images claimed as public files and released when dropped.

const ctx = testDbContext();
const NOW = Date.parse('2026-11-18T05:00:00Z');

describe.skipIf(!ctx.available)(`the site identity [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('site-identity');
  });

  afterAll(async () => {
    await db?.close();
  });

  const asStaff = <T>(fn: (tx: ReturnType<typeof txCtx>) => Promise<T>): Promise<T> =>
    withTx(db.h, (trx) => fn(txCtx(trx, NOW, { type: 'staff', id: db.staffId, ip: null })));

  async function refusal(p: Promise<unknown>): Promise<DomainError> {
    const e = await p.then(
      () => null,
      (error: unknown) => error,
    );
    if (!isDomainError(e)) throw new Error(`expected a DomainError, got ${String(e)}`);
    return e;
  }

  /** Uploads `bytes` into `context` as the staff user; the stored file's id. */
  async function upload(context: 'site.logo' | 'site.icon', bytes: Uint8Array, name = 'logo.png'): Promise<string> {
    const owner = uploadOwner(db.staffId);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { id } = await withTx(db.h, (trx) => createUpload(trx, { owner, context: uploadContext(context)!, size: bytes.byteLength, sha256, now: NOW, dataDir: db.dataDir }));
    await acceptChunk(db.h, { id, owner, n: 0, data: bytes, now: NOW, dataDir: db.dataDir });
    return ((await completeUpload(db.h, { id, owner, originalName: name, now: NOW, dataDir: db.dataDir })) as { fileId: string }).fileId;
  }

  const stored = async (id: string): Promise<Buffer> => (await readBytes(uploadPath(db.dataDir, id), 4 * 1024 * 1024))!;
  const fileRow = (id: string) => db.h.db.selectFrom('files').select(['context', 'mime', 'owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();
  const save = (revision: string, identity: SiteIdentity) => asStaff((tx) => saveSiteIdentity(tx, { revision, identity }, { keyring: KEYRING }));

  describe('the uploads', () => {
    it('a logo is stored as the PNG the server made of it: fitted in 960 x 240, alpha kept, no metadata and nothing appended', async () => {
      const secret = 'RAHASIA-di-dalam-berkas';
      const dirty = Buffer.concat([gradientPng(1200, 600).subarray(0, -12), pngChunk('tEXt', Buffer.from(`Comment\0${secret}`)), pngChunk('IEND'), Buffer.from(`<?php ${secret} ?>`)]);
      const id = await upload('site.logo', dirty);
      const bytes = await stored(id);
      expect(pngHeader(bytes)).toMatchObject({ width: 480, height: 240, colorType: 6 });
      expect(chunkTypes(bytes)).toEqual(['IHDR', 'IDAT', 'IEND']);
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.subarray(-12)).toEqual(pngChunk('IEND'));
      const row = await db.h.db.selectFrom('files').select(['context', 'mime', 'size', 'sha256', 'access', 'owner_type']).where('id', '=', id).executeTakeFirstOrThrow();
      expect(row).toEqual({ context: 'site.logo', mime: 'image/png', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), access: 'staff', owner_type: null });
      // A small logo is not enlarged.
      expect(pngHeader(await stored(await upload('site.logo', solidPng(120, 40))))).toMatchObject({ width: 120, height: 40 });
    });

    it('an icon is stored as its centre square of at most 512 px', async () => {
      expect(pngHeader(await stored(await upload('site.icon', gradientPng(700, 600), 'ikon.png')))).toMatchObject({ width: 512, height: 512 });
      expect(pngHeader(await stored(await upload('site.icon', solidPng(256, 300), 'ikon.png')))).toMatchObject({ width: 256, height: 256 });
    });

    it('refuses by content, whatever the file is called: SVG, JPEG, GIF, WebP, text and a renamed script (wrong type)', async () => {
      const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
      for (const [bytes, kind] of [
        [svg, 'svg'],
        [TINY_JPEG_BASELINE, 'jpeg'],
        [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'gif'],
        [webp, 'webp'],
        [Buffer.from('<?php system($_GET["c"]); ?>'), 'xml'],
      ] as const) {
        for (const context of ['site.logo', 'site.icon'] as const) {
          const e = await refusal(upload(context, bytes, 'logo.png'));
          expect(e.code, kind).toBe('UPLOAD_TYPE_REFUSED');
          expect(e.meta, kind).toEqual({ kind, allowed: ['png'] });
        }
      }
    });

    it('refuses a PNG it cannot decode (`damaged`), an interlaced one, one above 4000 px a side and one that is too small, and stores none of them', async () => {
      const before = await db.h.db.selectFrom('files').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      const good = solidPng(300, 300);
      const badCrc = Buffer.from(good);
      badCrc[badCrc.byteLength - 20] = badCrc[badCrc.byteLength - 20]! ^ 0xff;
      const cases: [Uint8Array, string, 'site.logo' | 'site.icon'][] = [
        [Buffer.concat([PNG_SIGNATURE, Buffer.from('<script>alert(1)</script>'.repeat(20))]), 'damaged', 'site.logo'],
        [good.subarray(0, good.byteLength - 30), 'damaged', 'site.logo'],
        [badCrc, 'damaged', 'site.icon'],
        [Buffer.concat([PNG_SIGNATURE, ihdr(64, 64, 8, 2, 1), pngChunk('IDAT', Buffer.alloc(4)), pngChunk('IEND')]), 'interlaced', 'site.logo'],
        // The header alone names the size: there is no pixel data to inflate at all.
        [Buffer.concat([PNG_SIGNATURE, ihdr(4001, 100, 8, 6), pngChunk('IEND')]), 'dimensions', 'site.logo'],
        [Buffer.concat([PNG_SIGNATURE, ihdr(300, 60000, 8, 6), pngChunk('IEND')]), 'dimensions', 'site.icon'],
        [solidPng(15, 100), 'too_small', 'site.logo'],
        [solidPng(255, 255), 'too_small', 'site.icon'],
        [handPng({ width: 1, height: 1, bitDepth: 8, colorType: 0, rows: [[1]] }), 'too_small', 'site.logo'],
      ];
      for (const [bytes, reason, context] of cases) {
        const e = await refusal(upload(context, bytes));
        expect(e.code, reason).toBe('UPLOAD_TYPE_REFUSED');
        expect(e.meta, reason).toEqual({ kind: 'png', allowed: ['png'], reason, minSide: context === 'site.logo' ? 16 : 256, maxSide: 4000 });
      }
      const after = await db.h.db.selectFrom('files').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      expect(Number(after.n)).toBe(Number(before.n));
      expect(Number((await db.h.db.selectFrom('upload_sessions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(0);
    });

    it('refuses a declared size above 1 MiB before any byte arrives', async () => {
      const owner = uploadOwner(db.staffId);
      for (const name of ['site.logo', 'site.icon'] as const) {
        const context = uploadContext(name)!;
        const e = await refusal(withTx(db.h, (trx) => createUpload(trx, { owner, context, size: 1024 * 1024 + 1, sha256: '0'.repeat(64), now: NOW, dataDir: db.dataDir })));
        expect(e.code).toBe('UPLOAD_TOO_LARGE');
      }
    });
  });

  describe('the setting', () => {
    it('until it is saved: the home page\'s old logo and the library\'s name; then the saved identity alone', async () => {
      const first = await readSiteIdentity(db.h.db);
      expect(first).toMatchObject({ identity: SITE_IDENTITY_DEFAULT, saved: false });
      expect(first.revision).toMatch(/^[0-9a-f]{16}$/);
      expect(publicSiteIdentity(first.identity, first.libraryName)).toMatchObject({ name: first.libraryName, logo: null, logoDark: null, hasIcon: false });

      // The home page gets a logo, as before the identity existed.
      const old = newId(NOW);
      await db.h.db
        .insertInto('files')
        .values({ id: old, original_name: 'logo.jpg', mime: 'image/jpeg', size: 10, sha256: '0'.repeat(64), context: 'opac.home_photo', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW, created_by: db.staffId })
        .execute();
      const home = await readOpacHome(db.h.db);
      await asStaff((tx) => saveOpacHome(tx, { revision: home.revision, home: { ...home.home, logo: { fileId: old, alt: 'Logo lama' } }, welcome: home.welcome }, { keyring: KEYRING }));
      const readOld = await readSiteIdentity(db.h.db);
      expect(readOld.saved).toBe(false);
      expect(readOld.identity).toEqual({ ...SITE_IDENTITY_DEFAULT, logo: { fileId: old, alt: 'Logo lama' } });
      expect(readOld.revision).not.toBe(first.revision);
      expect(publicSiteIdentity(readOld.identity, 'Perpustakaan Contoh').logo).toEqual({ url: `/files/${old}`, alt: 'Logo lama' });

      // A save at the revision loaded before the logo arrived is refused.
      expect((await refusal(save(first.revision, SITE_IDENTITY_DEFAULT))).code).toBe('CONFLICT_STALE');

      // The first save may keep the old logo: it becomes the identity's file.
      const saved = await save(readOld.revision, { ...readOld.identity, name: '  Pustaka Kenari  ', tagline: { id: 'Membaca untuk semua', en: '   ' } });
      expect(saved.changed).toEqual(['name', 'tagline']);
      const now = await readSiteIdentity(db.h.db);
      expect(now).toMatchObject({ saved: true, revision: saved.revision });
      expect(now.identity).toEqual({ ...SITE_IDENTITY_DEFAULT, logo: { fileId: old, alt: 'Logo lama' }, name: 'Pustaka Kenari', tagline: { id: 'Membaca untuk semua', en: null } });
      expect(await fileRow(old)).toMatchObject({ owner_type: 'settings', owner_id: 'site.identity', access: 'public' });
      const audit = await db.h.db.selectFrom('audit_log').select(['meta', 'entity']).where('action', '=', 'site.identity.update').execute();
      expect(audit).toHaveLength(1);
      expect(JSON.parse(String(audit[0]!.meta))).toEqual({ fields: ['name', 'tagline'], first: true });

      // From now on the home page's own logo is not read, and a save of the home page drops it without touching the file.
      const homeNow = await readOpacHome(db.h.db);
      expect(homeNow.home.logo).toEqual({ fileId: old, alt: 'Logo lama' });
      await asStaff((tx) => saveOpacHome(tx, { revision: homeNow.revision, home: homeNow.home, welcome: homeNow.welcome }, { keyring: KEYRING }));
      expect((await readOpacHome(db.h.db)).home.logo).toBeNull();
      expect(await fileRow(old)).toMatchObject({ owner_type: 'settings', owner_id: 'site.identity', access: 'public' });
      expect((await readSiteIdentity(db.h.db)).identity.logo).toEqual({ fileId: old, alt: 'Logo lama' });
    });

    it('a save claims the logo, the dark logo and the icon as public files, and releases the ones it drops', async () => {
      const [logo, dark, icon] = [await upload('site.logo', solidPng(400, 100)), await upload('site.logo', solidPng(400, 100, [255, 255, 255, 200])), await upload('site.icon', gradientPng(300, 300))];
      let state = await readSiteIdentity(db.h.db);
      const old = state.identity.logo!.fileId;
      const identity: SiteIdentity = { ...state.identity, logo: { fileId: logo, alt: '' }, logoDark: { fileId: dark }, icon: { fileId: icon }, showNameBesideLogo: false };
      const saved = await save(state.revision, identity);
      expect(saved.changed).toEqual(['logo', 'logoDark', 'icon', 'showNameBesideLogo']);
      for (const id of [logo, dark, icon]) expect(await fileRow(id)).toMatchObject({ owner_type: 'settings', owner_id: 'site.identity', access: 'public', mime: 'image/png' });
      // The old logo is released: no owner, staff only, for the housekeeping to remove.
      expect(await fileRow(old)).toMatchObject({ owner_type: null, owner_id: null, access: 'staff' });

      // A blank alternative text reads as the site's name; a blank name as the library's.
      state = await readSiteIdentity(db.h.db);
      const shown = publicSiteIdentity(state.identity, 'Perpustakaan Contoh');
      expect(shown).toEqual({
        name: 'Pustaka Kenari',
        tagline: { id: 'Membaca untuk semua', en: null },
        showNameBesideLogo: false,
        logo: { url: `/files/${logo}`, alt: 'Pustaka Kenari' },
        logoDark: { url: `/files/${dark}` },
        hasIcon: true,
        icon: { 32: `/site-icon/32.png?v=${icon}`, 180: `/site-icon/180.png?v=${icon}`, 192: `/site-icon/192.png?v=${icon}` },
      });
      expect(publicSiteIdentity({ ...state.identity, name: null }, 'Perpustakaan Contoh').name).toBe('Perpustakaan Contoh');

      // The icon in each size, made from the stored file.
      for (const size of [32, 180, 192] as const) {
        const png = (await siteIconPng(db.h.db, db.dataDir, icon, size))!;
        expect(decodePng(png, { maxSide: 4000 })).toMatchObject({ width: size, height: size });
      }
      // Not for a file that is not the identity's icon.
      expect(await siteIconPng(db.h.db, db.dataDir, logo, 32)).toBeNull();
      expect(await siteIconPng(db.h.db, db.dataDir, newId(NOW), 32)).toBeNull();

      // Dropping the dark logo and the icon releases both; the logo stays.
      const dropped = await save(state.revision, { ...state.identity, logoDark: null, icon: null });
      expect(dropped.changed).toEqual(['logoDark', 'icon']);
      expect(await fileRow(logo)).toMatchObject({ owner_id: 'site.identity', access: 'public' });
      for (const id of [dark, icon]) expect(await fileRow(id)).toMatchObject({ owner_type: null, owner_id: null, access: 'staff' });
    });

    it('refuses an image that is not there, of another context, in the wrong place or held by something else, each at its place', async () => {
      const state = await readSiteIdentity(db.h.db);
      const logo = await upload('site.logo', solidPng(200, 60));
      const icon = await upload('site.icon', solidPng(256, 256));
      const loose = newId(NOW);
      await db.h.db
        .insertInto('files')
        .values({ id: loose, original_name: 'foto.jpg', mime: 'image/jpeg', size: 10, sha256: '0'.repeat(64), context: 'opac.home_photo', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: NOW, created_by: db.staffId })
        .execute();
      const held = await upload('site.logo', solidPng(200, 60));
      await db.h.db.updateTable('files').set({ owner_type: 'records', owner_id: newId(NOW) }).where('id', '=', held).execute();
      const missing = newId(NOW);

      const cases: [Partial<SiteIdentity>, { path: string; code: string }[]][] = [
        [{ logo: { fileId: missing, alt: '' } }, [{ path: 'identity.logo.fileId', code: 'not_found' }]],
        // An icon is not a logo, a logo not an icon.
        [{ logo: { fileId: icon, alt: '' }, icon: { fileId: logo } }, [{ path: 'identity.logo.fileId', code: 'invalid' }, { path: 'identity.icon.fileId', code: 'invalid' }]],
        // A home page photo nobody holds is not the old logo; the dark logo is never a home page photo.
        [{ logo: { fileId: loose, alt: '' } }, [{ path: 'identity.logo.fileId', code: 'invalid' }]],
        [{ logoDark: { fileId: loose } }, [{ path: 'identity.logoDark.fileId', code: 'invalid' }]],
        [{ logoDark: { fileId: held } }, [{ path: 'identity.logoDark.fileId', code: 'invalid' }]],
      ];
      for (const [patch, errors] of cases) {
        const e = await refusal(save(state.revision, { ...state.identity, ...patch }));
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(e.meta?.['errors']).toEqual(errors);
      }
      expect((await readSiteIdentity(db.h.db)).revision).toBe(state.revision);
      expect(await fileRow(held)).toMatchObject({ owner_type: 'records', access: 'staff' });
    });
  });
});
