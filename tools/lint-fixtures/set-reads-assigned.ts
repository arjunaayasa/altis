import { sql, type Kysely } from 'kysely';

declare const db: Kysely<{ t: { a: number; b: number } }>;

// MySQL evaluates SET left to right: `b` would read the new `a`, on the other dialects the old one.
export const update = db.updateTable('t').set({ a: 1, b: sql`${sql.ref('a')} + 1` });
