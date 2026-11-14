import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@altis/shared';
import { expressionBuilder, sql, type Expression, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { AggregateOverflowError, countDistinctGrouped, countGrouped, datePrefix, sumGrouped } from '../src/aggregate.js';
import { runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import type { DB } from '../src/schema.js';

// The grouped counts and sums every report goes through (the one place for GROUP BY SQL): the helper adds the key
// selections, the aggregate and the GROUP BY to a query that only filters, and turns whatever the driver returns
// (a number, a MySQL DECIMAL string, a PostgreSQL bigint or numeric string) into a JS number, refusing anything a
// number cannot hold exactly. On the real K1 tables, on the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const T0 = 1_767_225_600_000;
const BIG = 4_503_599_627_370_496; // 2^52: two of them sum to 2^53, one more than a number holds exactly

/** A plugin that replaces column `column` of every row with `value`, whatever the driver returned. */
function driverReturns(column: string, value: unknown): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      return { ...result, rows: result.rows.map((row) => ({ ...row, [column]: value })) };
    },
  };
}

/** Rows sorted by their fields' values in field-name order, so that the comparison does not depend on the order the engine groups in. */
function sorted<T extends object>(rows: T[]): T[] {
  const text = (row: T) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
  return [...rows].sort((a, b) => text(a).localeCompare(text(b)));
}

describe.skipIf(!ctx.available)(`grouped counts and sums [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  const staffA = newId();
  const staffB = newId();

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-aggregate-grouped-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const trail = { archived_at: null, version: 0, created_at: T0, created_by: null, updated_at: T0, updated_by: null };

  beforeEach(async () => {
    await h.db.deleteFrom('staff_trainings').execute();
    await h.db.deleteFrom('library_staff').execute();
    await h.db.deleteFrom('library_activities').execute();
    await h.db.deleteFrom('library_budgets').execute();
    const activity = (kind: string, heldOn: string, archived = false) => ({
      id: newId(),
      branch_id: null,
      kind,
      title: `Kegiatan ${heldOn}`,
      held_on: heldOn,
      ended_on: null,
      participants: null,
      partner: null,
      uses_library_facility: 0,
      external_speaker: 0,
      description: null,
      ...trail,
      archived_at: archived ? T0 : null,
    });
    await h.db
      .insertInto('library_activities')
      .values([
        activity('reading_guidance', '2025-08-04'),
        activity('reading_guidance', '2025-08-20'),
        activity('reading_guidance', '2025-09-02'),
        activity('promotion', '2025-08-15'),
        activity('promotion', '2026-01-10', true),
      ])
      .execute();
    const staff = (id: string, name: string) => ({
      id,
      branch_id: null,
      staff_user_id: null,
      name,
      position: null,
      role: 'librarian',
      is_librarian: 1,
      employment: null,
      education_level: null,
      education_library: 0,
      library_training: 0,
      competency_cert: 0,
      association_member: 0,
      appointment_ref: null,
      starts_on: null,
      ends_on: null,
      ...trail,
    });
    await h.db.insertInto('library_staff').values([staff(staffA, 'Petugas A'), staff(staffB, 'Petugas B')]).execute();
    const training = (staffId: string, heldOn: string) => ({
      id: newId(),
      library_staff_id: staffId,
      title: 'Pelatihan',
      organizer: null,
      held_on: heldOn,
      hours: null,
      certificate_file_id: null,
      ...trail,
    });
    await h.db
      .insertInto('staff_trainings')
      .values([training(staffA, '2024-03-01'), training(staffA, '2024-09-01'), training(staffB, '2024-05-01'), training(staffA, '2025-02-01')])
      .execute();
  });

  const budget = (year: number, libraryMinor: number, collectionMinor: number | null) => ({
    id: newId(),
    scope_key: '',
    branch_id: null,
    year,
    library_minor: libraryMinor,
    parent_minor: null,
    parent_nonpersonnel_minor: null,
    collection_minor: collectionMinor,
    community_minor: null,
    currency: 'IDR',
    note: null,
    ...trail,
  });

  it('countGrouped: one row per kind and month of five activities, counts as numbers', async () => {
    const rows = await countGrouped(h.db.selectFrom('library_activities'), { kind: 'kind', month: datePrefix('held_on', 'month') });
    expect(sorted(rows)).toEqual([
      { count: 1, kind: 'promotion', month: '2025-08' },
      { count: 1, kind: 'promotion', month: '2026-01' },
      { count: 1, kind: 'reading_guidance', month: '2025-09' },
      { count: 2, kind: 'reading_guidance', month: '2025-08' },
    ]);
    for (const row of rows) expect(typeof row.count).toBe('number');
  });

  it('countGrouped keeps the WHERE of the query and replaces its selection, order and limit', async () => {
    const qb = h.db
      .selectFrom('library_activities')
      .select(['id', 'title'])
      .where('archived_at', 'is', null)
      .orderBy('title')
      .limit(1);
    const rows = await countGrouped(qb, { year: datePrefix('held_on', 'year') });
    expect(rows).toEqual([{ year: '2025', count: 4 }]);
  });

  it('countGrouped with no keys answers one row, also over no rows', async () => {
    expect(await countGrouped(h.db.selectFrom('library_activities'), {})).toEqual([{ count: 5 }]);
    expect(await countGrouped(h.db.selectFrom('library_activities').where('kind', '=', 'award'), {})).toEqual([{ count: 0 }]);
  });

  it('countDistinctGrouped: the staff members trained each year', async () => {
    const rows = await countDistinctGrouped(h.db.selectFrom('staff_trainings'), { year: datePrefix('held_on', 'year') }, 'library_staff_id');
    expect(sorted(rows)).toEqual([
      { count: 1, year: '2025' },
      { count: 2, year: '2024' },
    ]);
    for (const row of rows) expect(typeof row.count).toBe('number');
    expect(await countDistinctGrouped(h.db.selectFrom('staff_trainings'), {}, 'library_staff_id')).toEqual([{ count: 2 }]);
  });

  it('sumGrouped: budgets per year as numbers; a group whose values are all NULL sums to 0', async () => {
    await h.db.insertInto('library_budgets').values([budget(2024, 1_500_000_00, null), budget(2025, 2_000_000_00, 750_000_00)]).execute();
    const library = await sumGrouped(h.db.selectFrom('library_budgets'), { year: 'year' }, 'library_minor');
    expect(sorted(library)).toEqual([
      { sum: 150_000_000, year: 2024 },
      { sum: 200_000_000, year: 2025 },
    ]);
    for (const row of library) expect(typeof row.sum).toBe('number');
    const collection = await sumGrouped(h.db.selectFrom('library_budgets'), { year: 'year' }, 'collection_minor');
    expect(sorted(collection)).toEqual([
      { sum: 0, year: 2024 },
      { sum: 75_000_000, year: 2025 },
    ]);
    expect(await sumGrouped(h.db.selectFrom('library_budgets').where('year', '=', 1990), {}, 'library_minor')).toEqual([{ sum: 0 }]);
  });

  it('sumGrouped refuses a sum a number cannot hold exactly: two budgets of 2^52 → AggregateOverflowError', async () => {
    await h.db.insertInto('library_budgets').values([budget(2024, BIG, null), budget(2025, BIG, null)]).execute();
    expect(await sumGrouped(h.db.selectFrom('library_budgets'), { year: 'year' }, 'library_minor')).toHaveLength(2);
    const error = await sumGrouped(h.db.selectFrom('library_budgets'), {}, 'library_minor').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateOverflowError);
    expect((error as Error).name).toBe('AggregateOverflowError');
  });

  it('normalises what each driver returns: number, DECIMAL string, bigint; refuses fractions, negatives and values above 2^53 − 1', async () => {
    const sumWith = (value: unknown) =>
      sumGrouped(h.db.withPlugin(driverReturns('sum', value)).selectFrom('library_activities'), {}, 'participants');
    const countWith = (value: unknown) => countGrouped(h.db.withPlugin(driverReturns('count', value)).selectFrom('library_activities'), {});
    expect(await sumWith('150000000')).toEqual([{ sum: 150_000_000 }]); // MySQL/MariaDB DECIMAL, PostgreSQL numeric
    expect(await sumWith(150_000_000n)).toEqual([{ sum: 150_000_000 }]);
    expect(await sumWith(null)).toEqual([{ sum: 0 }]);
    expect(await sumWith('-25')).toEqual([{ sum: -25 }]);
    expect(await countWith('7')).toEqual([{ count: 7 }]); // PostgreSQL bigint as text
    expect(await countWith(String(Number.MAX_SAFE_INTEGER))).toEqual([{ count: Number.MAX_SAFE_INTEGER }]);
    for (const bad of ['1.5', '12abc', '', 1.5, '9007199254740992', 2 ** 53, 2n ** 53n, Number.NaN, {}, true]) {
      const error = await sumWith(bad).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ bad: String(bad), error: error instanceof AggregateOverflowError }).toEqual({ bad: String(bad), error: true });
    }
    for (const bad of [null, -1, '-1']) {
      const error = await countWith(bad).then(
        () => null,
        (e: unknown) => e,
      );
      expect({ bad: String(bad), error: error instanceof AggregateOverflowError }).toEqual({ bad: String(bad), error: true });
    }
  });

  it('refuses a query that already groups, filters groups or is DISTINCT (TypeError), and keys it cannot alias', async () => {
    const refused = async (p: () => Promise<unknown>) => {
      const error = await p().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TypeError);
    };
    await refused(() => countGrouped(h.db.selectFrom('library_activities').groupBy('kind'), { kind: 'kind' }));
    await refused(() => countGrouped(h.db.selectFrom('library_activities').groupBy('kind').having('kind', '=', 'x'), {}));
    await refused(() => countGrouped(h.db.selectFrom('library_activities').distinct(), { kind: 'kind' }));
    await refused(() => sumGrouped(h.db.selectFrom('library_budgets').groupBy('year'), {}, 'library_minor'));
    await refused(() => countDistinctGrouped(h.db.selectFrom('staff_trainings').groupBy('held_on'), {}, 'library_staff_id'));
    await refused(() => countGrouped(h.db.selectFrom('library_activities'), { count: 'kind' }));
    await refused(() => sumGrouped(h.db.selectFrom('library_budgets'), { sum: 'year' }, 'library_minor'));
    await refused(() => countGrouped(h.db.selectFrom('library_activities'), { 'a b': 'kind' }));
    await refused(() => sumGrouped(h.db.selectFrom('library_budgets'), {}, 'library_minor; drop'));
  });

  it('refuses a constant key before any SQL runs (GROUP BY reads a bare constant as a select-list position, PostgreSQL refuses a text one); a constant group goes in a derived table', async () => {
    // Counts the statements that ran (a result came back); building a query does not count.
    let sent = 0;
    const counting: KyselyPlugin = {
      transformQuery: ({ node }) => node,
      transformResult: async ({ result }) => {
        sent += 1;
        return result;
      },
    };
    const db = h.db.withPlugin(counting);
    const constants: [string, Expression<unknown>][] = [
      ['sql.lit text', sql.lit('semua')],
      ['sql.lit number', sql.lit(1)],
      ['sql.lit wrapped in a template', sql`${sql.lit('semua')}`],
      ['sql.lit in parentheses', sql`( ${sql.lit(2)} )`],
      ['a text constant written in a template', sql`'semua'`],
      ['a number written in a template', sql`1`],
      ['a number in parentheses written in a template', sql`(1)`],
      ['NULL written in a template', sql`null`],
      ['a literal of the expression builder', expressionBuilder<DB, 'library_activities'>().lit(1)],
    ];
    for (const [label, key] of constants) {
      for (const run of [
        () => countGrouped(db.selectFrom('library_activities'), { kind: 'kind', all: key }),
        () => countDistinctGrouped(db.selectFrom('staff_trainings'), { all: key }, 'library_staff_id'),
        () => sumGrouped(db.selectFrom('library_budgets'), { all: key }, 'library_minor'),
      ]) {
        const error = await run().then(
          () => null,
          (e: unknown) => e,
        );
        expect([label, error instanceof TypeError, String(error)]).toEqual([label, true, expect.stringMatching(/the key all is a constant.*derived table/)]);
      }
    }
    expect(sent).toBe(0);

    // The way to group by a constant: select it as a column of a derived table and group by that column.
    const all = db.selectFrom('library_activities').select([sql.lit('semua').as('grp'), 'kind']).as('x');
    expect(await countGrouped(db.selectFrom(all), { grp: 'x.grp' })).toEqual([{ grp: 'semua', count: 5 }]);
    // An expression with a literal inside it is not a constant: it still keys a group.
    expect(sorted(await countGrouped(db.selectFrom('library_activities'), { y: datePrefix('held_on', 'year'), k: sql`substr(${sql.ref('kind')}, 1, ${sql.lit(3)})` }))).toEqual([
      { count: 1, k: 'pro', y: '2025' },
      { count: 1, k: 'pro', y: '2026' },
      { count: 3, k: 'rea', y: '2025' },
    ]);
  });

  it('datePrefix: the month or year of a YYYY-MM-DD column; anything else is a TypeError', async () => {
    const rows = await h.db
      .selectFrom('library_activities')
      .select([datePrefix('held_on', 'month').as('m'), datePrefix('library_activities.held_on', 'year').as('y')])
      .where('held_on', '=', '2025-09-02')
      .execute();
    expect(rows).toEqual([{ m: '2025-09', y: '2025' }]);
    expect(() => datePrefix('held_on', 'day' as 'month')).toThrow(TypeError);
    expect(() => datePrefix('held_on) --', 'year')).toThrow(TypeError);
  });
});
