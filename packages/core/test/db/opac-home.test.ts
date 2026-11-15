import { createHash } from 'node:crypto';
import { TABLE_COLUMNS, withTx } from '@altis/db';
import { DomainError, isDomainError, newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { txCtx } from '../../src/context.js';
import { uploadContext } from '../../src/files/contexts.js';
import { acceptChunk, completeUpload, createUpload, uploadOwner } from '../../src/files/uploads.js';
import { readOpacHome, saveOpacHome } from '../../src/opac-home/content.js';
import { POPULAR_MIN_BORROWERS, popularRecordIds, popularTitlesStep, refreshPopularTitles } from '../../src/opac-home/popular.js';
import { REPORTS_HOUSEKEEPING_STEPS } from '../../src/reports/housekeeping/index.js';
import { indexRecords } from '../../src/search/index-records.js';
import { searchCatalog } from '../../src/search/search.js';
import { sizedJpeg } from '../fixtures/sized-jpeg.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import { masterId, seedBranch, seedCopy, seedLoan, seedMember } from '../support/circulation-seed.js';
import { KEYRING, openExportDb, type ExportDb } from './reports-export-support.js';

// The OPAC home page as the library's profile site (core opac-home): its content saved with a revision (a stale one is
// refused), its photos claimed as public files of the setting and released when dropped, and the popular titles: an
// aggregate of loan counts per title and branch, rebuilt from the last year's loans of titles the OPAC shows, that keeps
// a title only when enough different members borrowed it and never holds a borrower.

const ctx = testDbContext();
const NOW = Date.parse('2026-11-15T05:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!ctx.available)(`the OPAC home page [${engineLabel()}]`, () => {
  let db: ExportDb;

  beforeAll(async () => {
    db = await openExportDb('opac-home');
  });

  afterAll(async () => {
    await db?.close();
  });

  /** Runs `fn` as the staff user in a transaction at NOW. */
  const asStaff = <T>(fn: (tx: ReturnType<typeof txCtx>) => Promise<T>): Promise<T> =>
    withTx(db.h, (trx) => fn(txCtx(trx, NOW, { type: 'staff', id: db.staffId, ip: null })));

  /** A stored file row of `context`, owned as given; its id. */
  async function seedFile(context: string, owner: { type: string; id: string } | null = null): Promise<string> {
    const id = newId(NOW);
    await db.h.db
      .insertInto('files')
      .values({
        id,
        original_name: 'foto.jpg',
        mime: 'image/jpeg',
        size: 10,
        sha256: '0'.repeat(64),
        context,
        owner_type: owner?.type ?? null,
        owner_id: owner?.id ?? null,
        access: 'staff',
        status: 'ok',
        created_at: NOW,
        created_by: db.staffId,
      })
      .execute();
    return id;
  }

  const fileRow = (id: string) => db.h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();

  /** The DomainError a promise rejects with. */
  async function refusal(p: Promise<unknown>): Promise<DomainError> {
    const e = await p.then(
      () => null,
      (error: unknown) => error,
    );
    if (!isDomainError(e)) throw new Error(`expected a DomainError, got ${String(e)}`);
    return e;
  }

  describe('the photo uploads', () => {
    /** Uploads `bytes` as `opac.home_photo` of the staff user at NOW; the completion's answer. */
    async function upload(bytes: Uint8Array): Promise<unknown> {
      const owner = uploadOwner(db.staffId);
      const context = uploadContext('opac.home_photo')!;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const { id } = await withTx(db.h, (trx) => createUpload(trx, { owner, context, size: bytes.byteLength, sha256, now: NOW, dataDir: db.dataDir }));
      await acceptChunk(db.h, { id, owner, n: 0, data: bytes, now: NOW, dataDir: db.dataDir });
      return completeUpload(db.h, { id, owner, originalName: 'foto.jpg', now: NOW, dataDir: db.dataDir });
    }

    it('takes a JPEG of 240-2400 px a side, read from its frame header; refuses a smaller or larger one, and a PNG', async () => {
      const stored = (await upload(sizedJpeg(1600, 900))) as { fileId: string };
      expect(await db.h.db.selectFrom('files').select(['context', 'mime', 'access', 'owner_type']).where('id', '=', stored.fileId).executeTakeFirstOrThrow()).toEqual({
        context: 'opac.home_photo',
        mime: 'image/jpeg',
        access: 'staff',
        owner_type: null,
      });
      for (const [bytes, reason] of [
        [TINY_JPEG_BASELINE, 'dimensions'],
        [sizedJpeg(2401, 900), 'dimensions'],
        [sizedJpeg(1600, 239), 'dimensions'],
      ] as const) {
        const e = await refusal(upload(bytes));
        expect(e.code).toBe('UPLOAD_TYPE_REFUSED');
        expect(e.meta?.['reason']).toBe(reason);
      }
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 6, 64, 0, 0, 3, 132, 8, 2, 0, 0, 0, 0, 0, 0, 0]);
      expect((await refusal(upload(png))).code).toBe('UPLOAD_TYPE_REFUSED');
    });
  });

  describe('the content', () => {
    it('reads the defaults with a revision; a save writes the content and the welcome texts, audits the changed names only, and moves the revision', async () => {
      const first = await readOpacHome(db.h.db);
      expect(first.home).toEqual(OPAC_HOME_DEFAULT);
      expect(first.welcome).toEqual({ id: null, en: null });
      expect(first.revision).toMatch(/^[0-9a-f]{16}$/);

      const home: OpacHomeContent = {
        ...OPAC_HOME_DEFAULT,
        title: '  Ruang baca untuk semua  ',
        about: { text: 'Berdiri sejak 1987.', photo: null, founded: 1987, librarians: 3 },
        services: [{ title: 'Peminjaman', text: null }],
        hours: [{ days: 'Senin–Jumat', time: '07.00–15.00' }],
        blocks: { ...OPAC_HOME_DEFAULT.blocks, promoted: false },
      };
      const saved = await asStaff((tx) => saveOpacHome(tx, { revision: first.revision, home, welcome: { id: 'Selamat datang', en: '   ' } }, { keyring: KEYRING }));
      expect(saved.changed).toEqual(['opac.welcome.id', 'opac.home']);
      expect(saved.revision).not.toBe(first.revision);

      const after = await readOpacHome(db.h.db);
      expect(after.revision).toBe(saved.revision);
      expect(after.home.title).toBe('Ruang baca untuk semua');
      expect(after.home.blocks.promoted).toBe(false);
      expect(after.welcome).toEqual({ id: 'Selamat datang', en: null });

      const audit = await db.h.db.selectFrom('audit_log').select(['actor_id', 'meta']).where('action', '=', 'opac.home.update').execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_id).toBe(db.staffId);
      expect(JSON.parse(String(audit[0]!.meta))).toEqual({ keys: ['opac.welcome.id', 'opac.home'] });
    });

    it('refuses a save that names an older revision with CONFLICT_STALE, and changes nothing', async () => {
      const current = await readOpacHome(db.h.db);
      const stale = 'f'.repeat(16);
      const e = await refusal(asStaff((tx) => saveOpacHome(tx, { revision: stale, home: OPAC_HOME_DEFAULT, welcome: { id: null, en: null } }, { keyring: KEYRING })));
      expect(e.code).toBe('CONFLICT_STALE');
      expect(await readOpacHome(db.h.db)).toEqual(current);
    });

    it('claims the named photos as public files of the setting, releases the dropped ones, and refuses a file of another context or owner at its place', async () => {
      const hero = await seedFile('opac.home_photo');
      const about = await seedFile('opac.home_photo');
      const facility = await seedFile('opac.home_photo');
      let state = await readOpacHome(db.h.db);
      const withPhotos: OpacHomeContent = {
        ...state.home,
        hero: { fileId: hero, alt: 'Ruang baca', position: 60 },
        about: { ...state.home.about, photo: { fileId: about, alt: 'Rak buku', caption: null } },
        facilities: [{ fileId: facility, alt: 'Sudut baca', caption: 'Sudut baca' }],
      };
      await asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: withPhotos, welcome: state.welcome }, { keyring: KEYRING }));
      for (const id of [hero, about, facility]) expect(await fileRow(id)).toEqual({ owner_type: 'settings', owner_id: 'opac.home', access: 'public' });

      // Drop the facility photo: it loses its owner and turns staff (swept later as an orphan upload).
      state = await readOpacHome(db.h.db);
      await asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: { ...state.home, facilities: [] }, welcome: state.welcome }, { keyring: KEYRING }));
      expect(await fileRow(facility)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
      expect(await fileRow(hero)).toEqual({ owner_type: 'settings', owner_id: 'opac.home', access: 'public' });

      // A cover, a photo another owner holds, and an id with no file: refused where the body names them.
      state = await readOpacHome(db.h.db);
      const cover = await seedFile('catalog.cover');
      const held = await seedFile('opac.home_photo', { type: 'records', id: newId(NOW) });
      const missing = newId(NOW);
      const e = await refusal(
        asStaff((tx) =>
          saveOpacHome(
            tx,
            {
              revision: state.revision,
              home: {
                ...state.home,
                facilities: [
                  { fileId: cover, alt: 'Sampul', caption: null },
                  { fileId: held, alt: 'Dimiliki', caption: null },
                  { fileId: missing, alt: 'Tidak ada', caption: null },
                ],
              },
              welcome: state.welcome,
            },
            { keyring: KEYRING },
          ),
        ),
      );
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.meta?.['errors']).toEqual([
        { path: 'home.facilities.0.fileId', code: 'invalid' },
        { path: 'home.facilities.1.fileId', code: 'invalid' },
        { path: 'home.facilities.2.fileId', code: 'not_found' },
      ]);
      expect(await fileRow(cover)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
    });
  });

  describe('the popular titles', () => {
    let branchA: string;
    let branchB: string;
    const titles: Record<string, string> = {};
    const members: { id: string; no: string; name: string }[] = [];

    /** A loan of `recordId`'s copy `itemId` at `branchId` by `member`, `daysAgo` days before NOW. */
    async function lend(copy: { recordId: string; itemId: string }, branchId: string, member: number, daysAgo: number, outcome?: 'voided'): Promise<void> {
      const at = NOW - daysAgo * DAY;
      const on = new Date(at).toISOString().slice(0, 10);
      await seedLoan(db.h.db, { ...copy, memberId: members[member]!.id, branchId, loanedOn: on, loanedAt: at, dueOn: on, returnedOn: on, ...(outcome === undefined ? {} : { outcome }) });
    }

    beforeAll(async () => {
      const h = db.h.db;
      branchA = await seedBranch(h, 'POPA');
      branchB = await seedBranch(h, 'POPB');
      for (let i = 0; i < 4; i += 1) {
        const no = `POP-${i}`;
        const name = `Peminjam Rahasia ${i}`;
        members.push({ id: await seedMember(h, { no, name }), no, name });
      }
      const copy = async (key: string, title: string, branchId: string) => {
        const c = await seedCopy(h, { branchId, title, barcode: `POP-${key}` });
        titles[key] = c.recordId;
        return c;
      };
      // Three borrowers at A, five loans.
      const popular = await copy('popular', 'Laskar Pelangi', branchA);
      for (const m of [0, 1, 2, 0, 0]) await lend(popular, branchA, m, 10);
      // A second copy at B, so that a search filtered to B finds it.
      const atB = newId(NOW);
      await h
        .insertInto('items')
        .values({
          id: atB,
          record_id: popular.recordId,
          branch_id: branchB,
          barcode_display: 'POP-POPULAR-B',
          barcode_key: normalizeKey('POP-POPULAR-B'),
          collection_type_id: await masterId(h, 'collection_types', 'UMUM'),
          status: 'available',
          currency: 'IDR',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      // Three borrowers at B; one more loan at A by a single reader (not enough there).
      const second = await copy('second', 'Bumi Manusia', branchB);
      for (const m of [0, 1, 2]) await lend(second, branchB, m, 20);
      await lend(second, branchA, 3, 20);
      // One reader, six loans.
      const single = await copy('single', 'Ronggeng Dukuh Paruk', branchA);
      for (let k = 0; k < 6; k += 1) await lend(single, branchA, 3, 5 + k);
      // Three borrowers, but hidden from the OPAC.
      const hidden = await copy('hidden', 'Catatan Internal', branchA);
      for (const m of [0, 1, 2]) await lend(hidden, branchA, m, 3);
      await h.updateTable('records').set({ opac_visible: 0 }).where('id', '=', hidden.recordId).execute();
      // Three borrowers, every loan voided.
      const voided = await copy('voided', 'Pinjaman Batal', branchA);
      for (const m of [0, 1, 2]) await lend(voided, branchA, m, 3, 'voided');
      // Three borrowers, more than a year ago.
      const old = await copy('old', 'Siti Nurbaya', branchA);
      for (const m of [0, 1, 2]) await lend(old, branchA, m, 400);
      // Two borrowers at each branch: not enough at either.
      const spread = await copy('spread', 'Atheis', branchA);
      for (const m of [0, 1]) await lend(spread, branchA, m, 7);
      for (const m of [2, 3]) await lend(spread, branchB, m, 7);

      await withTx(db.h, (trx) => indexRecords(trx, Object.values(titles), NOW));
    });

    it('the rebuild is the last step of the reports housekeeping, age-based; the floor is three borrowers', () => {
      expect(REPORTS_HOUSEKEEPING_STEPS.at(-1)).toBe(popularTitlesStep);
      expect(popularTitlesStep).toMatchObject({ name: 'popular_titles', ageBased: true });
      expect(POPULAR_MIN_BORROWERS).toBe(3);
    });

    it('keeps a title per branch only with enough different borrowers, of titles the OPAC shows, lent in the last year, voided loans not counted', async () => {
      expect(await refreshPopularTitles(db.h, NOW)).toEqual({ titles: 2 });
      const rows = await db.h.db.selectFrom('opac_popular_titles').selectAll().orderBy('loans', 'desc').execute();
      expect(rows.map((r) => [r.record_id, r.branch_id, Number(r.loans), Number(r.refreshed_at)])).toEqual([
        [titles['popular'], branchA, 5, NOW],
        [titles['second'], branchB, 3, NOW],
      ]);
      expect(await popularRecordIds(db.h.db, 10)).toEqual([titles['popular'], titles['second']]);
      expect(await popularRecordIds(db.h.db, 1)).toEqual([titles['popular']]);

      // A rebuild replaces the whole table; a title hidden since is left out when read.
      await db.h.db.updateTable('records').set({ opac_visible: 0 }).where('id', '=', titles['popular']!).execute();
      expect(await popularRecordIds(db.h.db, 10)).toEqual([titles['second']]);
      await db.h.db.updateTable('records').set({ opac_visible: 1 }).where('id', '=', titles['popular']!).execute();
      expect(await refreshPopularTitles(db.h, NOW + 400 * DAY)).toEqual({ titles: 0 });
      expect(await db.h.db.selectFrom('opac_popular_titles').selectAll().execute()).toEqual([]);
      await refreshPopularTitles(db.h, NOW);
    });

    it('holds no borrower: its columns are a title, a branch, a count and a time, and no cell is a member id, number or name', async () => {
      expect(TABLE_COLUMNS.opac_popular_titles.map((c) => c.name)).toEqual(['record_id', 'branch_id', 'loans', 'refreshed_at']);
      const cells = (await db.h.db.selectFrom('opac_popular_titles').selectAll().execute()).flatMap((r) => Object.values(r).map((v) => String(v)));
      expect(cells.length).toBeGreaterThan(0);
      for (const m of members) {
        expect(cells).not.toContain(m.id);
        expect(cells.some((c) => c.includes(m.no) || c.includes(m.name))).toBe(false);
      }
    });

    it("orders the catalogue by the aggregate's loans (most borrowed), summed over the branches the search is filtered to", async () => {
      const ids = async (filters: { branchIds?: string[] } = {}) =>
        (await searchCatalog(db.h.db, { text: '', scope: 'opac', sort: 'popular', pageSize: 50, filters }, { now: NOW })).recordIds;
      const all = await ids();
      expect(all.slice(0, 2)).toEqual([titles['popular'], titles['second']]);
      expect(all).not.toContain(titles['hidden']);
      // At B only: the second title (3 loans there) before the popular one (its loans were at A).
      expect(await ids({ branchIds: [branchB] })).toEqual([titles['second'], titles['popular']]);
    });
  });
});
