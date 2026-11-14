// Komunitas, SLiMS members and circulation: what tables.test.ts expects of migration 0046, written out by hand in the
// notations of tables.test.ts. It creates no table: it adds `migration_archive.subject_key` (the member an archived
// SLiMS row is about) and its index. Kept in its own module so that tables.test.ts only spreads it in.

/** Which migration creates which tables: 0046 creates none. */
export const SLIMS_PEOPLE_TABLES_BY_MIGRATION: Record<string, string[]> = {
  '0046_migration_subject': [],
};

export interface SlimsPeopleIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** The index of 0046. */
export const SLIMS_PEOPLE_INDEXES: SlimsPeopleIndexFacts[] = [
  { table: 'migration_archive', name: 'ix_migration_archive_subject_key', unique: false, columns: ['subject_key'] },
];
