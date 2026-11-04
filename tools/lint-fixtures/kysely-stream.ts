import type { Kysely } from 'kysely';

declare const db: Kysely<{ jobs: { id: string; status: string } }>;

// Kysely's PostgreSQL .stream() needs pg-cursor, which is not wired (L31): page through readPkBatch instead.
export const rows = db.selectFrom('jobs').selectAll().stream();
