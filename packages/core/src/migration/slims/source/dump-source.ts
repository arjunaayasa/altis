import type { FileHandle } from 'node:fs/promises';
import { openRead, runWorkFileIn, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { SLIMS_COLUMNS } from './detect.js';
import type { SlimsRow, SlimsSource, SlimsTableInfo } from './types.js';

// The rows of a split dump (spec §11.1: "tahap berikut membaca staging dengan offset baris sebagai checkpoint"): one
// `<table>.ndjson` per table the migration reads, written by splitDump, one JSON object per row, a byte value as
// `{"$hex": "…"}`. The cursor is the line number of the next row, with its byte offset (`<line>:<offset>`) so that a
// resumed stage does not read the file again from its start; a plain line number is accepted too.
//
// The usage import (spec §11.2) splits with its own table and column list and reads back through `allowed`: only those
// tables are served, and each row only with those columns.

/** The most rows one call returns (§11.1: batches of at most 500). */
export const STAGED_BATCH_MAX = 500;
const READ_CHUNK = 64 * 1024;
/** The longest staging line accepted (a 16 MiB statement's row, JSON-escaped, stays below it). */
const LINE_MAX = 128 * 1024 * 1024;
const CURSOR = /^(\d{1,15})(?::(\d{1,15}))?$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

/** A row with only `columns`, in that order: those the row has (a column it lacks is left out, not NULL). */
export function projectRow(row: SlimsRow, columns: readonly string[]): SlimsRow {
  const out: SlimsRow = {};
  for (const c of columns) {
    if (!Object.hasOwn(row, c)) continue;
    if (c === '__proto__') Object.defineProperty(out, c, { value: row[c], enumerable: true, writable: true, configurable: true });
    else out[c] = row[c]!;
  }
  return out;
}

/** A table's info with only the columns of `columns` it has, in the order of `columns`. */
export function projectTableInfo(t: SlimsTableInfo, columns: readonly string[]): SlimsTableInfo {
  return { name: t.name, columns: columns.filter((c) => t.columns.includes(c)), primaryKey: [...t.primaryKey], rows: t.rows };
}

/** One row as a staging line (without its line feed). */
export function encodeStagedRow(row: SlimsRow): string {
  return JSON.stringify(row, function (this: Record<string, unknown>, key: string, value: unknown) {
    const original = key === '' ? undefined : this[key];
    return original instanceof Uint8Array ? { $hex: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('hex') } : value;
  });
}

/** A staging line back as its row. */
export function decodeStagedRow(line: string): SlimsRow {
  const row: unknown = JSON.parse(line, (key, value: unknown) => {
    if (key === '' || typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const keys = Object.keys(value);
    const hex = (value as { $hex?: unknown }).$hex;
    if (keys.length === 1 && typeof hex === 'string' && HEX.test(hex)) return new Uint8Array(Buffer.from(hex, 'hex'));
    return value;
  });
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw corrupt('not_a_row');
  return row as SlimsRow;
}

function corrupt(reason: string): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail: 'Berkas staging dump SLiMS rusak / A SLiMS dump staging file is damaged',
    meta: { reason },
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Reads `length` bytes at `position` (fewer at the end of the file). */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** The byte offset where line `line` (from 0) begins; the file's size when it has fewer lines. */
async function offsetOfLine(handle: FileHandle, line: number, size: number): Promise<number> {
  let seen = 0;
  for (let position = 0; position < size && seen < line; ) {
    const chunk = await readAt(handle, position, Math.min(READ_CHUNK, size - position));
    if (chunk.length === 0) break;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] === 0x0a) {
        seen += 1;
        if (seen === line) return position + i + 1;
      }
    }
    position += chunk.length;
  }
  return line === 0 ? 0 : size;
}

/**
 * The rows of a dump split by splitDump into `stagingDir` (the run's work folder), for the tables `tables` (splitDump's
 * last answer). Only the tables the migration reads were staged: any other table has no rows here. Each call opens
 * the table's file and closes it again, so the source holds nothing open between calls.
 *
 * With `o.allowed` (a split made with its own table list) only those tables are listed and served, each with only
 * those columns; without it, the tables of SLIMS_COLUMNS, whole.
 */
export function openStagedDumpSource(stagingDir: DataPath, tables: SlimsTableInfo[], o: { allowed?: Readonly<Record<string, readonly string[]>> } = {}): SlimsSource {
  const allowed = o.allowed;
  const served = allowed ?? SLIMS_COLUMNS;
  const copy = (t: SlimsTableInfo): SlimsTableInfo => ({ name: t.name, columns: [...t.columns], primaryKey: [...t.primaryKey], rows: t.rows });
  const list = allowed === undefined ? tables.map(copy) : tables.filter((t) => Object.hasOwn(allowed, t.name)).map((t) => projectTableInfo(t, allowed[t.name]!));
  const known = new Set(list.map((t) => t.name));

  return {
    kind: 'dump',
    async tables() {
      return list.map(copy);
    },
    async rows(table, after, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('rows: limit must be a positive integer');
      const m = after === null ? null : CURSOR.exec(after);
      if (after !== null && m === null) throw new TypeError('rows: not a cursor of this source');
      if (!known.has(table) || !Object.hasOwn(served, table)) return { rows: [], next: null };
      const columns = allowed === undefined ? null : allowed[table]!;
      const take = Math.min(limit, STAGED_BATCH_MAX);
      let handle: FileHandle;
      try {
        handle = await openRead(runWorkFileIn(stagingDir, `${table}.ndjson`));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return { rows: [], next: null };
        throw error;
      }
      try {
        const size = (await handle.stat()).size;
        const line = m === null ? 0 : Number(m[1]);
        let offset = m === null ? 0 : m[2] === undefined ? await offsetOfLine(handle, line, size) : Number(m[2]);
        if (offset > size) throw new TypeError('rows: the cursor lies past the end of the staging file');
        if (offset > 0 && (await readAt(handle, offset - 1, 1))[0] !== 0x0a) throw new TypeError('rows: the cursor does not point at a line');

        const rows: SlimsRow[] = [];
        let pieces: Buffer[] = [];
        let pending = 0;
        let position = offset;
        while (rows.length < take && position < size) {
          const chunk = await readAt(handle, position, Math.min(READ_CHUNK, size - position));
          if (chunk.length === 0) break;
          let from = 0;
          for (let i = 0; i < chunk.length && rows.length < take; i += 1) {
            if (chunk[i] !== 0x0a) continue;
            pieces.push(chunk.subarray(from, i));
            const row = decodeStagedRow(Buffer.concat(pieces).toString('utf8'));
            rows.push(columns === null ? row : projectRow(row, columns));
            pieces = [];
            pending = 0;
            from = i + 1;
            offset = position + i + 1;
          }
          if (rows.length < take && from < chunk.length) {
            pieces.push(chunk.subarray(from));
            pending += chunk.length - from;
            if (pending > LINE_MAX) throw corrupt('line_too_long');
          }
          position += chunk.length;
        }
        if (rows.length < take && pending > 0) throw corrupt('partial_line');
        return { rows, next: rows.length === take && offset < size ? `${line + rows.length}:${offset}` : null };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async close() {},
  };
}
