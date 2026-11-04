import { sql, type ExpressionBuilder, type Kysely } from 'kysely';

declare const db: Kysely<{ t: { a: number; b: number; count: number } }>;
declare const eb: ExpressionBuilder<{ t: { a: number; b: number; count: number } }, 't'>;

// A value may read the column it assigns itself: every dialect reads the old value there.
export const bump = db.updateTable('t').set({ count: sql`${sql.ref('count')} + 1` });

// `a` reads `b`, which is assigned after it: every dialect reads the old `b`.
export const swap = db.updateTable('t').set({ a: eb.ref('b'), b: 2 });
