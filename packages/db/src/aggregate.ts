import type { SelectQueryBuilder, SelectQueryNode } from 'kysely';
import { describe } from './checks.js';
import type { DB } from './schema.js';

// Counts (ruling L19). count(*) is a BIGINT, and the drivers hand it back as a number, a string or a bigint
// depending on the engine and on the size: SQLite and MySQL/MariaDB a number (a string above 2^53 with
// supportBigNumbers), PostgreSQL a number through the int8 parser of connect.ts (which throws above 2^53), and any
// other driver or setting a string or a bigint. countRows() is the one place that turns it into a JS number, so
// that no caller compares `'3' > 0` or adds a string to a number. Every count in 1b goes through it.

const COUNT_ALIAS = 'n';

/** A decimal count as text: digits only, no sign, no leading zeros, no blanks (what an integer column prints). */
const DECIMAL_COUNT = /^(?:0|[1-9][0-9]*)$/;

/** `value` as a JS number when it is a count a number holds exactly; a TypeError otherwise. */
function toCount(value: unknown): number {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') n = value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  else if (typeof value === 'string' && DECIMAL_COUNT.test(value)) n = Number(value);
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`countRows: count(*) returned ${describe(value)}, which is not a safe non-negative integer`);
  }
  return n;
}

/**
 * Why the count of `node` would not be the number of rows its query returns, or null. A GROUP BY or a DISTINCT
 * collapses rows, and a UNION is more than one SELECT: wrapping them in count(*) would answer something else.
 */
function notCountable(node: SelectQueryNode): string | null {
  if (node.groupBy !== undefined) return 'a GROUP BY';
  if (node.having !== undefined) return 'a HAVING';
  if (node.distinctOn !== undefined) return 'a DISTINCT ON';
  if (node.setOperations !== undefined) return 'a UNION, INTERSECT or EXCEPT';
  const modifiers = [...(node.frontModifiers ?? []), ...(node.endModifiers ?? [])];
  if (modifiers.some((m) => m.modifier === 'Distinct')) return 'a DISTINCT';
  return null;
}

/**
 * The number of rows `qb` selects: its selection is replaced by `count(*)`, and its ORDER BY, LIMIT and OFFSET are
 * dropped (PostgreSQL refuses an ORDER BY on a bare count, and an OFFSET would skip the one result row), so a page
 * query counts its total. Its FROM, JOINs and WHERE stay; a query that goes through a transaction counts inside it.
 *
 * @returns a JS number, whatever type the driver returns (number, string or bigint)
 * @throws TypeError when the value is not a safe integer, when no row comes back, or when the query has a
 *   GROUP BY, HAVING, DISTINCT or set operation (its count(*) would not be the number of its rows)
 */
export async function countRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qb: SelectQueryBuilder<DB, any, any>,
): Promise<number> {
  const unsupported = notCountable(qb.toOperationNode());
  if (unsupported !== null) {
    throw new TypeError(`countRows: the query has ${unsupported}, so count(*) would not be its number of rows`);
  }
  const row = await qb
    .clearSelect()
    .clearOrderBy()
    .clearLimit()
    .clearOffset()
    .select((eb) => eb.fn.countAll().as(COUNT_ALIAS))
    .executeTakeFirst();
  if (row === undefined) throw new TypeError('countRows: the count query returned no row');
  return toCount((row as Record<string, unknown>)[COUNT_ALIAS]);
}
