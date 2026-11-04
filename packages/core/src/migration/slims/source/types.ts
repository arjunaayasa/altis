// What the SLiMS migration reads from (spec §11.1; Phase 2 Task 3, owned by Task 10 afterwards): a source of rows (a
// MySQL/MariaDB connection, or a mysqldump split into per-table staging), a source of files (the uploaded zip, or a
// SLiMS folder through the CLI), and the version the tables look like. The framework (Task 23) and the stages (Tasks 37,
// 38) are written against these shapes only, so they need none of Task 10's code.

/** One row of a SLiMS table: text, numbers, NULL, or bytes (a `_binary` or `0x…` literal, a BLOB). */
export type SlimsRow = Record<string, string | number | null | Uint8Array>;

/** A table of the source: its columns in order, its primary key, and its row count when known. */
export interface SlimsTableInfo {
  name: string;
  columns: string[];
  primaryKey: string[];
  rows: number | null;
  /**
   * Task 10: `no_pk` when a database table has no primary key, so its rows are paged by offset (rows the source
   * changes during the migration may then be skipped or read twice; the report says so).
   */
  flags?: SlimsTableFlag[];
}

/** See {@link SlimsTableInfo.flags}. */
export type SlimsTableFlag = 'no_pk';

/** Rows of a SLiMS database, read in keyset batches (≤ 500 rows, `SELECT` only). */
export interface SlimsSource {
  kind: 'db' | 'dump';
  tables(): Promise<SlimsTableInfo[]>;
  /**
   * At most `limit` rows of `table` after the cursor `after` (null: from the start), and the cursor of the next batch
   * (null at the end). The cursor is opaque text the stage keeps in its checkpoint.
   */
  rows(table: string, after: string | null, limit: number): Promise<{ rows: SlimsRow[]; next: string | null }>;
  close(): Promise<void>;
}

/** A direct connection (§11.1). The password lives in the job's sealed `secret_param`, never in a payload. */
export interface SlimsDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: boolean;
}

/**
 * Where `splitDump` stopped (Task 10): plain JSON of a bounded size (at most 512 tables of ASCII names), carried in the
 * job's payload. A resumed split cuts every staging file back to its size here and reads on from `offset`.
 */
export interface SplitCheckpoint {
  /** The bytes of the (decompressed) dump read so far: the end of the last whole statement. */
  offset: number;
  /** The byte size of each staging file at `offset`, by file name (`<table>.ndjson`, and the table list's file). */
  files: Record<string, number>;
  /** The rows seen so far per table, those only counted (not staged) included. */
  rows?: Record<string, number>;
  /** The staging bytes written when the disk headroom was last checked (S10). */
  headroomAt?: number;
}

/**
 * The attachment, cover and content files of a SLiMS install: `repository/…`, `images/docs/…`, `images/content/…`
 * (paths relative to the SLiMS root, `/`-separated).
 */
export interface SlimsFilesSource {
  /**
   * The content of `rel`, or null when the source has no such file. With `maxBytes` (S10), an entry whose declared or
   * actually produced uncompressed size passes the limit makes the iterator throw {@link SlimsFileTooLargeError}.
   */
  open(rel: string, o?: { maxBytes?: number }): Promise<AsyncIterable<Uint8Array> | null>;
  /** The size of `rel` in bytes, or null when the source has no such file. */
  size(rel: string): Promise<number | null>;
  close(): Promise<void>;
}

/** A file of the SLiMS files source that passed the size limit it was opened with (S10). */
export class SlimsFileTooLargeError extends Error {
  readonly rel: string;
  readonly limit: number;

  constructor(rel: string, limit: number) {
    super(`SLiMS file larger than ${limit} bytes`);
    this.name = 'SlimsFileTooLargeError';
    this.rel = rel;
    this.limit = limit;
  }
}

/**
 * The version the source's tables look like (§11.1: detected by the core tables and columns, not a version number):
 * `9` (Bulian, fully supported), `8` (best effort), or `unknown`; the core tables it lacks, and per table the columns
 * this release does not know.
 */
export interface SlimsVersionInfo {
  version: '9' | '8' | 'unknown';
  missing: string[];
  unknownColumns: Record<string, string[]>;
}
