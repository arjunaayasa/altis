// The SLiMS sources (spec §11.1; Phase 2 Task 10): the direct connection (db-source.ts over @altis/db's foreign
// client), the SQL dump (sql-dump.ts, split into per-table staging by dump-split.ts and read back by dump-source.ts),
// the files (files-source.ts: the uploaded zip or the CLI folder), the version detection (detect.ts) and the text
// clean-up (clean-text.ts, php-unserialize.ts). Task 3's names are unchanged.

export { DB_BATCH_MAX, DB_CONNECT_TIMEOUT_MS, openDbSource } from './db-source.js';
export type { DbUnreachableReason, OpenDbSourceOptions } from './db-source.js';
export { FILES_ZIP_MAX_ENTRIES, openFilesDir, openFilesZip } from './files-source.js';
export { SLIMS_ARCHIVED_TABLES, SLIMS_COLUMNS, SLIMS_DERIVED_TABLES, detectSlimsVersion, slimsTableRole } from './detect.js';
export type { SlimsTableRole } from './detect.js';
export { SPLIT_HEADROOM_STEP, SPLIT_MAX_TABLES, splitDump } from './dump-split.js';
export type { SplitDumpOptions } from './dump-split.js';
export { STAGED_BATCH_MAX, openStagedDumpSource } from './dump-source.js';
export { DUMP_INSERT_BATCH, DUMP_LITERAL_MAX, DumpParseError, createSqlDumpParser } from './sql-dump.js';
export type { DumpEvent, DumpMark, DumpParseErrorCode, SqlDumpParser, SqlDumpParserOptions } from './sql-dump.js';
export { cleanDate, cleanText, decodeCell, extractYear, fixMojibake, textCell } from './clean-text.js';
export type { SlimsTextFix } from './clean-text.js';
export { phpUnserialize } from './php-unserialize.js';
export { SlimsFileTooLargeError } from './types.js';
export type { SlimsDbConfig, SlimsFilesSource, SlimsRow, SlimsSource, SlimsTableFlag, SlimsTableInfo, SlimsVersionInfo, SplitCheckpoint } from './types.js';
