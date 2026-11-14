import {
  listNames,
  openAppend,
  readBytes,
  removeFile,
  runWorkDir,
  runWorkFileIn,
  runWorkPath,
  statOrNull,
  truncateFile,
  writeBytesAtomic,
  writeBytesInFolder,
  type DataPath,
} from '@altis/platform';
import { z } from 'zod';
import type { SplitCheckpoint } from '../../migration/slims/source/types.js';
import type { DateSpan } from '../windows.js';
import { emptyCounts, type MemberInfo, type MonthEntry, type UsageCounts } from './count.js';

// The work files of a SLiMS usage import, in its run folder `tmp/<runId>/`, and where its slices stand. They hold only
// months, member hashes, codes and counts, never a name or a raw member id:
//
//   usage-state.json             where the import stands (phase, step, the source's cursor, the split's checkpoint) and
//                                every count so far; rewritten whole (atomically) at the end of each slice, it is what
//                                the next slice resumes from
//   usage-members.bin            member hash → type id, membership end (one JSON line each)
//   usage-items.bin              copy → title; usage-titles.bin: title → class (JSON lines)
//   usage-loans.bin              the ids of the `loan` rows met (JSON lines)
//   usage-visits-<YYYY-MM>.bin   the members' check-ins of a month: 16 bytes of hash, the second of the month (uint32)
//   usage-borrows-<YYYY-MM>.bin  the members' loans of a month, the same way
//   usage-carry-<YYYY-MM>.bin    what the month before carries into this month: hash, second (int32, ≤ 0)
//   usage-span<k>-*.json|bin     per period span: the copies and titles used, the borrowers' and visitors' hashes
//   usage-tables.json            the staged dump's tables (a dump source, after the split)
//
// A slice appends to the append-only files (members, items, titles, loans, the months' check-ins and loans) and
// records their lengths in the state it writes last, so a slice killed before its state was written leaves bytes the
// next slice cuts off again. What it appends waits in memory, a few chunks per file, only until about
// APPEND_FLUSH_BYTES are waiting: the job writes them out after every page it reads (flushOver), so a slice's memory does
// not grow with the rows it reads; bytes written before a kill are cut off the same way. The span sets are unions rewritten whole, and a replayed slice adds the same members again;
// the carry of a month is written once its month is read and read by the next month, both idempotent.

/** The phases of an import, in order (a database source starts at `members`). */
export const USAGE_PHASES = Object.freeze(['split', 'members', 'loans', 'visits', 'reads', 'aggregate', 'write', 'report'] as const);

export type UsagePhase = (typeof USAGE_PHASES)[number];

/** Where an import stands and what it counted (usage-state.json). */
export interface UsageState {
  v: 1;
  /** The slices that saved a state so far. */
  seq: number;
  phase: UsagePhase;
  /** A reading phase: the table it reads (an index into its tables); the aggregate step: the month. */
  step: number;
  /** The source's cursor in the table being read. */
  cursor: string | null;
  split: SplitCheckpoint | null;
  /** The period's span and the two before it, oldest first. */
  spans: DateSpan[];
  /** Member type id → name, from `mst_member_type`. */
  types: Record<string, string>;
  counts: UsageCounts;
  /** The bytes of each append-only work file. */
  files: Record<string, number>;
  /** The months whose members' check-ins or loans have a work file, sorted. */
  months: string[];
  /** What the write step stored: months and rows. */
  written: { months: number; rows: number } | null;
}

/** A failure that ends the import `failed` at once, with a code for its report. */
export class UsageRunFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`SLiMS usage import failed: ${code}`);
    this.name = 'UsageRunFailure';
    this.code = code;
  }
}

const STATE_FILE = 'usage-state.json';
/** The state is read back whole up to this size. */
const STATE_MAX_BYTES = 64 * 1024 * 1024;
/** An append-only work file (its length is in the state). */
const APPEND_FILE = /^usage-(?:members|items|titles|loans|(?:visits|borrows)-\d{4}-\d{2})\.bin$/;
/** A month's entry: 16 bytes of hash and the second of the month. */
const ENTRY_BYTES = 20;
const HASH_BYTES = 16;
/** Appends wait in memory until about this many bytes do; then the job writes them out (flushOver). */
export const APPEND_FLUSH_BYTES = 1024 * 1024;
/** The appends of one file are gathered in chunks of this size (a larger append gets a chunk of its own size). */
const CHUNK_BYTES = 16 * 1024;

/** What one append-only file has waiting: the chunks filled and the one being filled. */
interface Pending {
  full: Buffer[];
  chunk: Buffer;
  used: number;
}

const spanSchema = z.strictObject({ from: z.string(), to: z.string() });
const countsSchema = z.strictObject({
  rows: z.record(z.string(), z.int().min(0)),
  dateInvalid: z.record(z.string(), z.int().min(0)),
  afterCutover: z.record(z.string(), z.int().min(0)),
  loanSeenBefore: z.int().min(0),
  memberUnknown: z.strictObject({ loans: z.int().min(0), visits: z.int().min(0) }),
  monthly: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.int().min(0)))),
});
const stateSchema = z.strictObject({
  v: z.literal(1),
  seq: z.int().min(0),
  phase: z.enum(USAGE_PHASES),
  step: z.int().min(0),
  cursor: z.string().nullable(),
  split: z.looseObject({ offset: z.int().min(0), files: z.record(z.string(), z.int().min(0)) }).nullable(),
  spans: z.array(spanSchema).length(3),
  types: z.record(z.string(), z.string()),
  counts: countsSchema,
  files: z.record(z.string(), z.int().min(0)),
  months: z.array(z.string()),
  written: z.strictObject({ months: z.int().min(0), rows: z.int().min(0) }).nullable(),
});

/** A new state at `phase` for the spans `spans`. */
export function initialState(phase: UsagePhase, spans: readonly DateSpan[]): UsageState {
  return {
    v: 1,
    seq: 0,
    phase,
    step: 0,
    cursor: null,
    split: null,
    spans: spans.map((s) => ({ from: s.from, to: s.to })),
    types: {},
    counts: emptyCounts(),
    files: {},
    months: [],
    written: null,
  };
}

/** The JSON lines of `bytes`, parsed. */
function jsonLines(bytes: Buffer): unknown[] {
  const out: unknown[] = [];
  for (const line of bytes.toString('utf8').split('\n')) if (line !== '') out.push(JSON.parse(line));
  return out;
}

/** The work of one import across a slice: its state, the files it reads and what it appends. */
export class UsageWork {
  readonly dataDir: string;
  readonly runId: string;
  state: UsageState;
  private readonly appends = new Map<string, Pending>();
  /** The bytes waiting in `appends`. */
  private waiting = 0;
  private readonly sets = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private membersMap: Map<string, MemberInfo> | null = null;
  private itemsMap: Map<string, string> | null = null;
  private titlesMap: Map<string, string> | null = null;
  private loansSet: Set<string> | null = null;
  private readonly monthSet: Set<string>;
  /** Whether the work folder was there when the slice began (a database source's first slice makes it). */
  private folder: boolean;

  private constructor(dataDir: string, runId: string, state: UsageState, folder: boolean) {
    this.dataDir = dataDir;
    this.runId = runId;
    this.state = state;
    this.folder = folder;
    this.monthSet = new Set(state.months);
  }

  /**
   * The import's work as the last slice that saved its state left it (`initial` when none did), its append-only
   * files cut back to the lengths that state records.
   *
   * @throws UsageRunFailure `work_corrupt` (a state or a file that does not match), `work_missing` (a file the state
   *   records is gone)
   */
  static async open(dataDir: string, runId: string, initial: () => UsageState): Promise<UsageWork> {
    const raw = await readBytes(runWorkPath(dataDir, runId, STATE_FILE), STATE_MAX_BYTES);
    let state: UsageState;
    if (raw === null) {
      state = initial();
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new UsageRunFailure('work_corrupt');
      }
      const checked = stateSchema.safeParse(parsed);
      if (!checked.success) throw new UsageRunFailure('work_corrupt');
      state = checked.data as UsageState;
    }
    const folder = (await statOrNull(runWorkDir(dataDir, runId)))?.kind === 'dir';
    const work = new UsageWork(dataDir, runId, state, folder);
    await work.reconcile();
    return work;
  }

  /** The work folder. */
  get dir(): DataPath {
    return runWorkDir(this.dataDir, this.runId);
  }

  /** The work file `name`. */
  path(name: string): DataPath {
    return runWorkPath(this.dataDir, this.runId, name);
  }

  /** Cuts every append-only file back to the length the state records; removes those it does not record. */
  private async reconcile(): Promise<void> {
    const names = new Set((await listNames(this.dir)).filter((n) => APPEND_FILE.test(n)));
    for (const name of names) {
      const recorded = this.state.files[name];
      const file = runWorkFileIn(this.dir, name);
      if (recorded === undefined) {
        await removeFile(file);
        continue;
      }
      const stat = await statOrNull(file);
      if (stat === null || stat.kind !== 'file' || stat.size < recorded) throw new UsageRunFailure('work_corrupt');
      if (stat.size > recorded) await truncateFile(file, recorded);
    }
    for (const [name, size] of Object.entries(this.state.files)) {
      if (size > 0 && !names.has(name)) throw new UsageRunFailure('work_missing');
    }
  }

  /** The bytes of the append-only file `name` the state records (empty when it records none). */
  private async recorded(name: string): Promise<Buffer> {
    const size = this.state.files[name] ?? 0;
    if (size === 0) return Buffer.alloc(0);
    const bytes = await readBytes(this.path(name), size + 1);
    if (bytes === null) throw new UsageRunFailure('work_missing');
    if (bytes.length !== size) throw new UsageRunFailure('work_corrupt');
    return bytes;
  }

  /** The bytes appended and not written yet. */
  get waitingBytes(): number {
    return this.waiting;
  }

  /** Room for `n` more bytes of `name`: the pending chunk to write them into at its `used`. */
  private room(name: string, n: number): Pending {
    let p = this.appends.get(name);
    if (p === undefined) {
      p = { full: [], chunk: Buffer.allocUnsafe(Math.max(CHUNK_BYTES, n)), used: 0 };
      this.appends.set(name, p);
    } else if (p.used + n > p.chunk.length) {
      if (p.used > 0) p.full.push(p.chunk.subarray(0, p.used));
      p.chunk = Buffer.allocUnsafe(Math.max(CHUNK_BYTES, n));
      p.used = 0;
    }
    this.waiting += n;
    return p;
  }

  /** Appends `bytes` to the append-only file `name` (written by flush). */
  append(name: string, bytes: Uint8Array): void {
    const p = this.room(name, bytes.length);
    p.chunk.set(bytes, p.used);
    p.used += bytes.length;
  }

  /** Appends one JSON line to `name`. */
  appendLine(name: string, value: unknown): void {
    const text = `${JSON.stringify(value)}\n`;
    const n = Buffer.byteLength(text, 'utf8');
    const p = this.room(name, n);
    p.chunk.write(text, p.used, n, 'utf8');
    p.used += n;
  }

  /** Appends a member's entry of `month` to its file of `kind`. */
  appendEntry(kind: 'visits' | 'borrows', month: string, e: MonthEntry): void {
    const p = this.room(`usage-${kind}-${month}.bin`, ENTRY_BYTES);
    p.chunk.write(e.hash, p.used, HASH_BYTES, 'hex');
    p.chunk.writeUInt32LE(e.second, p.used + HASH_BYTES);
    p.used += ENTRY_BYTES;
    if (!this.monthSet.has(month)) {
      this.monthSet.add(month);
      this.state.months = [...this.monthSet].sort();
    }
  }

  /**
   * Replaces the work file `file`: inside the folder only once it exists (a folder removed meanwhile means the run was
   * ended elsewhere), creating it on the first write of a database source.
   *
   * @throws UsageRunFailure `work_missing` when the folder is gone
   */
  private async write(file: DataPath, bytes: string | Uint8Array): Promise<void> {
    if (!this.folder) {
      await writeBytesAtomic(file, bytes);
      this.folder = true;
      return;
    }
    if (!(await writeBytesInFolder(file, bytes))) throw new UsageRunFailure('work_missing');
  }

  /** The members' entries of `month` in its file of `kind` (what this slice appended included). */
  async entries(kind: 'visits' | 'borrows', month: string): Promise<MonthEntry[]> {
    await this.flush();
    const bytes = await this.recorded(`usage-${kind}-${month}.bin`);
    if (bytes.length % ENTRY_BYTES !== 0) throw new UsageRunFailure('work_corrupt');
    const out: MonthEntry[] = [];
    for (let at = 0; at < bytes.length; at += ENTRY_BYTES) {
      out.push({ hash: bytes.toString('hex', at, at + HASH_BYTES), second: bytes.readUInt32LE(at + HASH_BYTES) });
    }
    return out;
  }

  /** What the month before carries into `month`. */
  async carryInto(month: string): Promise<Map<string, number>> {
    const bytes = await readBytes(this.path(`usage-carry-${month}.bin`), 64 * 1024 * 1024);
    const out = new Map<string, number>();
    if (bytes === null) return out;
    if (bytes.length % ENTRY_BYTES !== 0) throw new UsageRunFailure('work_corrupt');
    for (let at = 0; at < bytes.length; at += ENTRY_BYTES) out.set(bytes.toString('hex', at, at + HASH_BYTES), bytes.readInt32LE(at + HASH_BYTES));
    return out;
  }

  /** Writes what a month carries into `month` (nothing to carry: no file). */
  async writeCarry(month: string, carry: ReadonlyMap<string, number>): Promise<void> {
    const file = this.path(`usage-carry-${month}.bin`);
    if (carry.size === 0) {
      await removeFile(file);
      return;
    }
    const bytes = Buffer.alloc(carry.size * ENTRY_BYTES);
    let at = 0;
    for (const [hash, second] of carry) {
      bytes.write(hash, at, HASH_BYTES, 'hex');
      bytes.writeInt32LE(second, at + HASH_BYTES);
      at += ENTRY_BYTES;
    }
    await this.write(file, bytes);
  }

  /** The members read so far: hash → type and membership end. */
  async members(): Promise<Map<string, MemberInfo>> {
    if (this.membersMap !== null) return this.membersMap;
    const map = new Map<string, MemberInfo>();
    for (const line of jsonLines(await this.recorded('usage-members.bin'))) {
      const [hash, type, expire] = line as [string, string | null, string | null];
      if (!map.has(hash)) map.set(hash, { type, expire });
    }
    return (this.membersMap = map);
  }

  /** Copy → title, read so far (the first line of a copy wins). */
  async items(): Promise<Map<string, string>> {
    if (this.itemsMap !== null) return this.itemsMap;
    const map = new Map<string, string>();
    for (const line of jsonLines(await this.recorded('usage-items.bin'))) {
      const [code, title] = line as [string, string];
      if (!map.has(code)) map.set(code, title);
    }
    return (this.itemsMap = map);
  }

  /** Title → class key ('' without its own classification), read so far (the last line of a title wins). */
  async titles(): Promise<Map<string, string>> {
    if (this.titlesMap !== null) return this.titlesMap;
    const map = new Map<string, string>();
    for (const line of jsonLines(await this.recorded('usage-titles.bin'))) {
      const [title, key] = line as [string, string];
      map.set(title, key);
    }
    return (this.titlesMap = map);
  }

  /** The ids of the `loan` rows met so far. */
  async loans(): Promise<Set<string>> {
    if (this.loansSet !== null) return this.loansSet;
    const set = new Set<string>();
    for (const line of jsonLines(await this.recorded('usage-loans.bin'))) set.add(line as string);
    return (this.loansSet = set);
  }

  /**
   * The span set `name` (`span<k>-items`, `span<k>-titles`: text; `span<k>-borrowers`, `span<k>-visitors`: hashes),
   * read once per slice; a caller that adds to it marks it changed (changed()).
   */
  async set(name: string): Promise<Set<string>> {
    const known = this.sets.get(name);
    if (known !== undefined) return known;
    const hashes = name.endsWith('-borrowers') || name.endsWith('-visitors');
    const bytes = await readBytes(this.path(`usage-${name}.${hashes ? 'bin' : 'json'}`), 1024 * 1024 * 1024);
    const set = new Set<string>();
    if (bytes !== null) {
      if (hashes) {
        if (bytes.length % HASH_BYTES !== 0) throw new UsageRunFailure('work_corrupt');
        for (let at = 0; at < bytes.length; at += HASH_BYTES) set.add(bytes.toString('hex', at, at + HASH_BYTES));
      } else {
        for (const v of JSON.parse(bytes.toString('utf8')) as string[]) set.add(v);
      }
    }
    this.sets.set(name, set);
    return set;
  }

  /** Marks the span set `name` changed: written at the next save. */
  changed(name: string): void {
    this.dirty.add(name);
  }

  /** Writes the buffered appends, recording each file's new length in the state (saved by save()). */
  private async flush(): Promise<void> {
    if (this.appends.size > 0) this.folder = true; // openAppend makes the folder
    for (const [name, p] of this.appends) {
      const parts = p.used > 0 ? [...p.full, p.chunk.subarray(0, p.used)] : p.full;
      let size = 0;
      const handle = await openAppend(this.path(name));
      try {
        for (const bytes of parts) {
          let at = 0;
          while (at < bytes.length) at += (await handle.write(bytes, at, bytes.length - at)).bytesWritten;
          size += bytes.length;
        }
      } finally {
        await handle.close();
      }
      this.state.files[name] = (this.state.files[name] ?? 0) + size;
      this.appends.delete(name);
    }
    this.waiting = 0;
  }

  /**
   * Writes the appends out once `bound` bytes or more wait (the job calls it after every page it reads). A slice killed
   * after it leaves bytes past the lengths the saved state records, which the next slice cuts off (see the top).
   */
  async flushOver(bound = APPEND_FLUSH_BYTES): Promise<void> {
    if (this.waiting >= bound) await this.flush();
  }

  /**
   * Saves the slice's work: the appends, the changed span sets, then the state (see the top of this file).
   *
   * @throws UsageRunFailure `work_missing` when the work folder is gone (the run was ended elsewhere)
   */
  async save(): Promise<void> {
    await this.flush();
    for (const name of this.dirty) {
      const set = this.sets.get(name)!;
      const hashes = name.endsWith('-borrowers') || name.endsWith('-visitors');
      let bytes: Buffer;
      if (hashes) {
        bytes = Buffer.alloc(set.size * HASH_BYTES);
        let at = 0;
        for (const hash of set) at += bytes.write(hash, at, HASH_BYTES, 'hex');
      } else {
        bytes = Buffer.from(JSON.stringify([...set]), 'utf8');
      }
      await this.write(this.path(`usage-${name}.${hashes ? 'bin' : 'json'}`), bytes);
    }
    this.dirty.clear();
    this.state.seq += 1;
    await this.write(this.path(STATE_FILE), JSON.stringify(this.state));
  }
}
