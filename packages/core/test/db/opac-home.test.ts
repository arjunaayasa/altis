import { createHash } from 'node:crypto';
import { TABLE_COLUMNS, withTx } from '@altis/db';
import { DomainError, isDomainError, newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { txCtx } from '../../src/context.js';
import { uploadContext } from '../../src/files/contexts.js';
import { acceptChunk, completeUpload, createUpload, uploadOwner } from '../../src/files/uploads.js';
import { CLASS_MIN_BORROWERS, classActivityStep, refreshClassActivity, topClasses } from '../../src/opac-home/class-activity.js';
import { readOpacHome, saveOpacHome } from '../../src/opac-home/content.js';
import { shelfCounts, shelfStatuses } from '../../src/opac-home/shelf-status.js';
import { POPULAR_MIN_BORROWERS, popularRecordIds, popularTitlesStep, refreshPopularTitles } from '../../src/opac-home/popular.js';
import { REPORTS_HOUSEKEEPING_STEPS } from '../../src/reports/housekeeping/index.js';
import { indexRecords } from '../../src/search/index-records.js';
import { searchCatalog } from '../../src/search/search.js';
import { sizedJpeg } from '../fixtures/sized-jpeg.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import { masterId, seedBranch, seedCopy, seedLoan, seedMember } from '../support/circulation-seed.js';
import { KEYRING, openExportDb, type ExportDb } from './reports-export-support.js';

// The OPAC home page as the library's profile site (core opac-home): its content saved with a revision (a stale one is
// refused), its photos claimed as public files of the setting and released when dropped, a content saved before its texts
// were per language still read as before, the popular titles (an aggregate of loan counts per title and branch, rebuilt
// from the last year's loans of titles the OPAC shows, that keeps a title only when enough different members borrowed
// it and never holds a borrower), and the loans per class (counts per class, kept only with five or more different
// borrowers, never a member).

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
        title: { id: '  Ruang baca untuk semua  ', en: 'A reading room for all' },
        brand: '#1E3A8A',
        about: { text: { id: 'Berdiri sejak 1987.', en: null }, photo: null, founded: 1987, librarians: 3 },
        services: [{ title: 'Peminjaman', text: null }],
        hours: [{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] }],
        blocks: { ...OPAC_HOME_DEFAULT.blocks, promoted: false, readingClasses: true },
      };
      const saved = await asStaff((tx) => saveOpacHome(tx, { revision: first.revision, home, welcome: { id: 'Selamat datang', en: '   ' } }, { keyring: KEYRING }));
      expect(saved.changed).toEqual(['opac.welcome.id', 'opac.home']);
      expect(saved.revision).not.toBe(first.revision);

      const after = await readOpacHome(db.h.db);
      expect(after.revision).toBe(saved.revision);
      expect(after.home.title).toEqual({ id: 'Ruang baca untuk semua', en: 'A reading room for all' });
      expect(after.home.brand).toBe('#1e3a8a');
      expect(after.home.hours[0]!.weekdays).toEqual([1, 2, 3, 4, 5]);
      expect(after.home.blocks.promoted).toBe(false);
      expect(after.home.blocks.readingClasses).toBe(true);
      expect(after.welcome).toEqual({ id: 'Selamat datang', en: null });

      const audit = await db.h.db.selectFrom('audit_log').select(['actor_id', 'meta']).where('action', '=', 'opac.home.update').execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_id).toBe(db.staffId);
      expect(JSON.parse(String(audit[0]!.meta))).toEqual({ keys: ['opac.welcome.id', 'opac.home'] });
    });

    it('reads a content saved before its texts were per language as before: the texts as the Indonesian ones, the new fields at their defaults', async () => {
      const current = (await db.h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirstOrThrow()).value!;
      const legacy = {
        title: 'Ruang baca lama',
        hero: null,
        about: { text: 'Paragraf lama.', photo: null, founded: null, librarians: null },
        services: [],
        facilities: [],
        hours: [{ days: 'Senin–Jumat', time: '07.00–15.00' }],
        blocks: { classes: true, popular: true, newTitles: true, promoted: true, about: true, services: true, news: true, visit: false },
      };
      await db.h.db.updateTable('settings').set({ value: JSON.stringify(legacy) }).where('key', '=', 'opac.home').execute();
      try {
        const read = await readOpacHome(db.h.db);
        expect(read.home.title).toEqual({ id: 'Ruang baca lama', en: null });
        expect(read.home.about.text).toEqual({ id: 'Paragraf lama.', en: null });
        expect(read.home.brand).toBeNull();
        expect(read.home.hours).toEqual([{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [] }]);
        expect(read.home.blocks).toEqual({ ...legacy.blocks, readingClasses: false });
      } finally {
        await db.h.db.updateTable('settings').set({ value: current }).where('key', '=', 'opac.home').execute();
      }
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
        hero: { fileId: hero, alt: 'Ruang baca', position: 60, overlay: 70 },
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

    it('the rebuild is a step of the reports housekeeping, age-based; the floor is three borrowers', () => {
      expect(REPORTS_HOUSEKEEPING_STEPS).toContain(popularTitlesStep);
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

  describe('the loans per class', () => {
    const members: { id: string; no: string; name: string }[] = [];
    const copies: { recordId: string; itemId: string }[] = [];
    let branch: string;

    /** A loan of copy `c` by member `m` (null: an anonymised borrower), `daysAgo` days before NOW, counted in `className`. */
    async function lend(c: number, m: number | null, className: string | null, daysAgo: number, outcome?: 'voided'): Promise<void> {
      const at = NOW - daysAgo * DAY;
      const on = new Date(at).toISOString().slice(0, 10);
      await seedLoan(db.h.db, {
        ...copies[c]!,
        memberId: m === null ? null : members[m]!.id,
        branchId: branch,
        loanedOn: on,
        loanedAt: at,
        dueOn: on,
        returnedOn: on,
        className,
        ...(outcome === undefined ? {} : { outcome }),
      });
    }

    beforeAll(async () => {
      const h = db.h.db;
      branch = await seedBranch(h, 'KLS');
      for (let i = 0; i < 12; i += 1) {
        const no = `KLS-${i}`;
        const name = `Pembaca Kelas Rahasia ${i}`;
        members.push({ id: await seedMember(h, { no, name, className: 'XI IPA 2' }), no, name });
      }
      for (let i = 0; i < 4; i += 1) copies.push(await seedCopy(h, { branchId: branch, title: `Buku Kelas ${i}`, barcode: `KLS-B${i}` }));
      // XI IPA 2: five borrowers (one spelling it in lower case), three titles, eight loans, one by an anonymised borrower.
      for (const [m, c] of [[0, 0], [1, 1], [2, 2], [3, 0], [0, 1], [1, 0]] as const) await lend(c, m, 'XI IPA 2', 10);
      await lend(2, 4, 'xi ipa 2', 12);
      await lend(0, null, 'XI IPA 2', 14);
      // X-1: four borrowers, many loans: not enough borrowers.
      for (const m of [5, 6, 7, 8, 5, 5, 6, 6, 7, 8]) await lend(3, m, 'X-1', 20);
      // IX: four borrowers and three loans of anonymised borrowers: still four.
      for (const m of [5, 6, 7, 8, null, null, null]) await lend(1, m, 'IX', 20);
      // XII: five borrowers, more than a year ago.
      for (const m of [0, 1, 2, 3, 4]) await lend(0, m, 'XII', 400);
      // VOID: five borrowers, every loan voided.
      for (const m of [0, 1, 2, 3, 4]) await lend(0, m, 'VOID', 5, 'voided');
      // XII IPS 1: six borrowers, six loans of one title.
      for (const m of [6, 7, 8, 9, 10, 11]) await lend(3, m, 'XII IPS 1', 30);
      // No class in the snapshot: never counted.
      for (const m of [0, 1, 2, 3, 4, 5]) await lend(1, m, null, 3);
    });

    it('the rebuild is the last step of the reports housekeeping, age-based; the floor is five borrowers', () => {
      expect(REPORTS_HOUSEKEEPING_STEPS.at(-1)).toBe(classActivityStep);
      expect(classActivityStep).toMatchObject({ name: 'class_activity', ageBased: true });
      expect(CLASS_MIN_BORROWERS).toBe(5);
    });

    it('keeps a class only with five different borrowers in the last year, voided loans and loans without a class not counted; letter case is one class', async () => {
      expect(await refreshClassActivity(db.h, NOW)).toEqual({ classes: 2 });
      const top = await topClasses(db.h.db, 10);
      expect(top.map((c) => ({ ...c, className: c.className.toUpperCase() }))).toEqual([
        { place: 1, className: 'XI IPA 2', loans: 8, titles: 3 },
        { place: 2, className: 'XII IPS 1', loans: 6, titles: 1 },
      ]);
      // The spelling most of its loans carry (MySQL and MariaDB compare the spellings as equal and keep either).
      if (db.h.dialect !== 'mysql' && db.h.dialect !== 'mariadb') expect(top[0]!.className).toBe('XI IPA 2');
      expect((await topClasses(db.h.db, 1)).map((c) => c.place)).toEqual([1]);
      const rows = await db.h.db.selectFrom('opac_class_activity').select('refreshed_at').execute();
      expect(rows.map((r) => Number(r.refreshed_at))).toEqual([NOW, NOW]);

      // A year later nothing is left; the rebuild replaces the whole table.
      expect(await refreshClassActivity(db.h, NOW + 400 * DAY)).toEqual({ classes: 0 });
      expect(await db.h.db.selectFrom('opac_class_activity').selectAll().execute()).toEqual([]);
      await refreshClassActivity(db.h, NOW);
    });

    it('holds no member: its columns are a place, a class, two counts and a time, and no cell is a member id, number or name', async () => {
      expect(TABLE_COLUMNS.opac_class_activity.map((c) => c.name)).toEqual(['place', 'class_name', 'loans', 'titles', 'refreshed_at']);
      const cells = (await db.h.db.selectFrom('opac_class_activity').selectAll().execute()).flatMap((r) => Object.values(r).map((v) => String(v)));
      expect(cells.length).toBeGreaterThan(0);
      for (const m of members) {
        expect(cells).not.toContain(m.id);
        expect(cells.some((c) => c.includes(m.no) || c.includes(m.name))).toBe(false);
      }
    });
  });

  // ---- Komunitas (OPAC look) ----
  describe('the logo and the public contact', () => {
    it('claims the logo as a public file of the setting like the photos, and releases it when it is dropped', async () => {
      const logo = await seedFile('opac.home_photo');
      let state = await readOpacHome(db.h.db);
      await asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: { ...state.home, logo: { fileId: logo, alt: 'Logo perpustakaan' } }, welcome: state.welcome }, { keyring: KEYRING }));
      expect(await fileRow(logo)).toEqual({ owner_type: 'settings', owner_id: 'opac.home', access: 'public' });
      expect((await readOpacHome(db.h.db)).home.logo).toEqual({ fileId: logo, alt: 'Logo perpustakaan' });
      state = await readOpacHome(db.h.db);
      await asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: { ...state.home, logo: null }, welcome: state.welcome }, { keyring: KEYRING }));
      expect(await fileRow(logo)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });
    });

    it("refuses a contact e-mail that is a staff user's or a member's address (any case); takes the library's own", async () => {
      const staffEmail = 'Pustakawan.Satu@Sekolah.example';
      await db.h.db.updateTable('staff_users').set({ email_display: staffEmail, email_key: normalizeKey(staffEmail) }).where('id', '=', db.staffId).execute();
      const member = await seedMember(db.h.db, { no: 'KONTAK-1', name: 'Anggota Kontak' });
      await db.h.db.updateTable('members').set({ email: 'anggota.kontak@rumah.example' }).where('id', '=', member).execute();
      try {
        for (const email of ['pustakawan.satu@sekolah.example', 'ANGGOTA.KONTAK@rumah.example']) {
          const state = await readOpacHome(db.h.db);
          const e = await refusal(
            asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: { ...state.home, contact: { phone: null, email } }, welcome: state.welcome }, { keyring: KEYRING })),
          );
          expect(e.code, email).toBe('VALIDATION_FAILED');
          expect(e.meta?.['errors']).toEqual([{ path: 'home.contact.email', code: 'personal_email' }]);
          expect((await readOpacHome(db.h.db)).home.contact.email).toBeNull();
        }
        const state = await readOpacHome(db.h.db);
        const contact = { phone: '(021) 555-0101', email: 'perpustakaan@sekolah.example' };
        await asStaff((tx) => saveOpacHome(tx, { revision: state.revision, home: { ...state.home, contact }, welcome: state.welcome }, { keyring: KEYRING }));
        expect((await readOpacHome(db.h.db)).home.contact).toEqual(contact);
      } finally {
        await db.h.db.updateTable('staff_users').set({ email_display: null, email_key: null }).where('id', '=', db.staffId).execute();
        await db.h.db.updateTable('members').set({ email: null }).where('id', '=', member).execute();
      }
    });
  });

  describe("what a card says of a title's copies", () => {
    let branch: string;
    let memberId: string;
    const copies: Record<string, { recordId: string; itemId: string }> = {};

    /** One more copy of `recordId`, with `status` and the collection type `collection`. */
    async function addCopy(recordId: string, barcode: string, status: string, collection = 'UMUM'): Promise<string> {
      const id = newId(NOW);
      await db.h.db
        .insertInto('items')
        .values({
          id,
          record_id: recordId,
          branch_id: branch,
          barcode_display: barcode,
          barcode_key: normalizeKey(barcode),
          collection_type_id: await masterId(db.h.db, 'collection_types', collection),
          status,
          currency: 'IDR',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      return id;
    }

    beforeAll(async () => {
      branch = await seedBranch(db.h.db, 'RAK');
      memberId = await seedMember(db.h.db, { no: 'RAK-7', name: 'Peminjam Rahasia' });
      for (const [key, title] of [
        ['all', 'Semua di rak'],
        ['some', 'Sebagian di rak'],
        ['out', 'Semua dipinjam'],
        ['ref', 'Hanya referensi'],
        ['none', 'Tak satu pun'],
        ['gone', 'Hanya yang hilang'],
      ] as const) {
        copies[key] = await seedCopy(db.h.db, { branchId: branch, title, barcode: `RAK-${key}` });
      }
      await addCopy(copies['all']!.recordId, 'RAK-all-2', 'available');
      // Some: one on the shelf, one on loan, one for use in the library, one withdrawn (not counted at all).
      const lent = await addCopy(copies['some']!.recordId, 'RAK-some-2', 'available');
      await seedLoan(db.h.db, { itemId: lent, recordId: copies['some']!.recordId, memberId, branchId: branch, loanedOn: '2026-11-10', dueOn: '2026-11-24' });
      await addCopy(copies['some']!.recordId, 'RAK-some-3', 'not_for_loan');
      await addCopy(copies['some']!.recordId, 'RAK-some-4', 'withdrawn');
      // Out: both copies on loan; the earliest due date is the one said.
      const second = await addCopy(copies['out']!.recordId, 'RAK-out-2', 'available');
      await seedLoan(db.h.db, { ...copies['out']!, memberId, branchId: branch, loanedOn: '2026-11-10', dueOn: '2026-11-28' });
      await seedLoan(db.h.db, { itemId: second, recordId: copies['out']!.recordId, memberId, branchId: branch, loanedOn: '2026-11-11', dueOn: '2026-11-21' });
      // Ref: a copy available in a collection type that is not lent, and one not for loan.
      const reference = newId(NOW);
      await db.h.db
        .insertInto('collection_types')
        .values({ id: reference, code_display: 'REFRAK', code_key: 'REFRAK', name_id: 'Referensi rak', name_en: 'Shelf reference', loanable: 0, created_at: NOW, updated_at: NOW })
        .execute();
      await db.h.db.updateTable('items').set({ collection_type_id: reference }).where('id', '=', copies['ref']!.itemId).execute();
      await addCopy(copies['ref']!.recordId, 'RAK-ref-2', 'not_for_loan');
      // None: under repair; Gone: lost and archived copies only.
      await db.h.db.updateTable('items').set({ status: 'repair' }).where('id', '=', copies['none']!.itemId).execute();
      await db.h.db.updateTable('items').set({ status: 'lost' }).where('id', '=', copies['gone']!.itemId).execute();
      await db.h.db.updateTable('items').set({ archived_at: NOW }).where('id', '=', await addCopy(copies['gone']!.recordId, 'RAK-gone-2', 'available')).execute();
    });

    it('one grouped read for many titles: each state counted, the earliest due date of the loans, a title without counted copies absent', async () => {
      const ids = Object.values(copies).map((c) => c.recordId);
      const counts = await shelfCounts(db.h.db, ids);
      expect(counts.get(copies['all']!.recordId)).toEqual({ shelf: 2, library: 0, loan: 0, held: 0, other: 0, earliestDue: null });
      expect(counts.get(copies['some']!.recordId)).toEqual({ shelf: 1, library: 1, loan: 1, held: 0, other: 0, earliestDue: '2026-11-24' });
      expect(counts.get(copies['out']!.recordId)).toEqual({ shelf: 0, library: 0, loan: 2, held: 0, other: 0, earliestDue: '2026-11-21' });
      expect(counts.get(copies['ref']!.recordId)).toEqual({ shelf: 0, library: 2, loan: 0, held: 0, other: 0, earliestDue: null });
      expect(counts.get(copies['none']!.recordId)).toEqual({ shelf: 0, library: 0, loan: 0, held: 0, other: 1, earliestDue: null });
      expect(counts.has(copies['gone']!.recordId)).toBe(false);
      const statuses = await shelfStatuses(db.h.db, ids);
      expect(Object.fromEntries(Object.entries(copies).map(([key, c]) => [key, statuses.get(c.recordId) ?? null]))).toEqual({
        all: { kind: 'available', shelf: 2, total: 2 },
        some: { kind: 'available', shelf: 1, total: 3 },
        out: { kind: 'on_loan', dueOn: '2026-11-21' },
        ref: { kind: 'library_use' },
        none: { kind: 'unavailable' },
        gone: null,
      });
      expect(await shelfCounts(db.h.db, [])).toEqual(new Map());
    });
  });

  describe('the exact ISBN/ISSN filter of the search', () => {
    it('matches the stored ISBN in its 10- and 13-digit forms with or without hyphens, an ISSN, and nothing for other text', async () => {
      const branch = await seedBranch(db.h.db, 'ISBN');
      const book = await seedCopy(db.h.db, { branchId: branch, title: 'Buku Ber-ISBN', barcode: 'ISBN-1' });
      const journal = await seedCopy(db.h.db, { branchId: branch, title: 'Jurnal Ber-ISSN', barcode: 'ISSN-1' });
      // Another title only mentions the ISBN in its notes: a text match, never an exact one.
      const mention = await seedCopy(db.h.db, { branchId: branch, title: 'Buku Lain', barcode: 'ISBN-2' });
      await db.h.db.updateTable('records').set({ notes: 'Terjemahan dari 979-3062-79-7' }).where('id', '=', mention.recordId).execute();
      await db.h.db
        .insertInto('record_identifiers')
        .values([
          { id: newId(NOW), record_id: book.recordId, type: 'isbn', value_display: '978-979-3062-79-2', value_key: '9789793062792' },
          { id: newId(NOW), record_id: journal.recordId, type: 'issn', value_display: '0317-8471', value_key: '03178471' },
        ])
        .execute();
      await withTx(db.h, (trx) => indexRecords(trx, [book.recordId, journal.recordId, mention.recordId], NOW));
      const find = async (identifier: string) => (await searchCatalog(db.h.db, { text: '', scope: 'opac', filters: { identifier } }, { now: NOW })).recordIds;
      for (const typed of ['978-979-3062-79-2', '9789793062792', '979-3062-79-7', '9793062797', 'ISBN 979 3062 79 7']) expect(await find(typed), typed).toEqual([book.recordId]);
      expect(await find('0317-8471')).toEqual([journal.recordId]);
      for (const other of ['Buku', '978', '9780000000002', 'x'.repeat(80)]) expect(await find(other), other).toEqual([]);
      // The text search still finds the mention; the filter narrows a text search to the exact holder.
      expect((await searchCatalog(db.h.db, { text: '9793062797', scope: 'opac' }, { now: NOW })).recordIds).toContain(book.recordId);
      expect((await searchCatalog(db.h.db, { text: 'buku', scope: 'opac', filters: { identifier: '9793062797' } }, { now: NOW })).recordIds).toEqual([book.recordId]);
    });
  });
});
