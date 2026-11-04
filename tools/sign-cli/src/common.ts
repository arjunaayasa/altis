/**
 * Plumbing shared by the altis-sign commands: the two error kinds and their exit codes, option parsing, strict JSON
 * files, atomic writes, the --root-keys and keyset files, and the dev public keys. Node built-ins and @altis/crypto
 * only, so the tool runs on an offline signing machine with nothing but Node and this repository.
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { parseArgs } from 'node:util';
import { KEYSET_MAX_FILE_BYTES, isTrustedKey, parseKeysetDocs, parseStrictJson, type KeysetDoc, type TrustedKey } from '@altis/crypto';

/** Where a command prints: one line at a time, stdout and stderr. */
export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

/**
 * Test hooks (preflight M10): given only by `runCliForTest` of src/testing.ts, which the package's `exports` do not
 * publish, so `runCli` can never be pointed at another dev key list.
 */
export type TestHooks = {
  /** Where tools/keys/dev/trusted.json is. Default: the repository's. */
  devTrustedFile?: string;
};

/** What `runCli` runs with: no hook. */
export const NO_HOOKS: Readonly<TestHooks> = Object.freeze({});

/** The command line is wrong (exit code 2). */
export class UsageError extends Error {}

/** The command cannot be carried out (exit code 1). */
export class CliError extends Error {}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `keys` sorted. */
export const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).sort().join(',') === keys.join(',');

const ENVELOPE_FIELDS = ['alg', 'kid', 'sig', 'typ'];

/**
 * A keyset file entry of the right shape: exactly `{raw, env}`, `raw` a string, `env` exactly `{typ, kid, alg, sig}` of
 * strings. Whether it counts is resolveTrustedKeys' business; a signing tool refuses a file with any other entry
 * (parseKeysetDocs checks only the file's limits).
 */
export function isKeysetDocShape(doc: unknown): doc is KeysetDoc {
  return (
    isRecord(doc) &&
    hasExactKeys(doc, ['env', 'raw']) &&
    typeof doc['raw'] === 'string' &&
    isRecord(doc['env']) &&
    hasExactKeys(doc['env'], ENVELOPE_FIELDS) &&
    ENVELOPE_FIELDS.every((field) => typeof (doc['env'] as Record<string, unknown>)[field] === 'string')
  );
}

export interface OptionSpec {
  /** `--name value`, required. */
  required?: string[];
  /** `--name value`, at most once. */
  optional?: string[];
  /** `--name value`, any number of times. */
  multiple?: string[];
  /** `--name`, no value. */
  flags?: string[];
}

export interface ParsedOptions {
  /** Every required option, and the optional ones given. */
  values: Record<string, string>;
  lists: Record<string, string[]>;
  flags: Record<string, boolean>;
}

/** Parses the options of a command: nothing outside `spec`, no positional argument (UsageError). */
export function parseOptions(args: string[], spec: OptionSpec): ParsedOptions {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const name of [...(spec.required ?? []), ...(spec.optional ?? [])]) options[name] = { type: 'string' };
  for (const name of spec.multiple ?? []) options[name] = { type: 'string', multiple: true };
  for (const name of spec.flags ?? []) options[name] = { type: 'boolean' };
  let parsed: Record<string, unknown>;
  try {
    parsed = parseArgs({ args, options, allowPositionals: false, strict: true }).values;
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const result: ParsedOptions = { values: {}, lists: {}, flags: {} };
  for (const name of spec.required ?? []) {
    const value = parsed[name];
    if (typeof value !== 'string') throw new UsageError('missing --' + name);
    result.values[name] = value;
  }
  for (const name of spec.optional ?? []) {
    const value = parsed[name];
    if (typeof value === 'string') result.values[name] = value;
  }
  for (const name of spec.multiple ?? []) {
    const value = parsed[name];
    result.lists[name] = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
  for (const name of spec.flags ?? []) result.flags[name] = parsed[name] === true;
  return result;
}

/** Parses `--name value` pairs; every name in `names` is required and nothing else is accepted. */
export function requiredOptions(args: string[], names: string[]): Record<string, string> {
  return parseOptions(args, { required: names }).values;
}

/** Writes `text` to `file` as a whole: temporary file in the same directory, fsync, rename. */
export async function writeTextAtomic(file: string, text: string, mode = 0o644): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = await fsp.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(temporary, file);
  } catch (err) {
    await fsp.rm(temporary, { force: true });
    throw err;
  }
}

/** Reads a file as text; `what` names it in the error (CliError). */
export async function readText(file: string, what: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${what} ${file}: ${messageOf(err)}`);
  }
}

/** Reads a file as strict JSON; `what` names it in error messages. */
export async function readStrictJson(file: string, what: string): Promise<unknown> {
  const text = await readText(file, what);
  try {
    return parseStrictJson(text);
  } catch (err) {
    throw new CliError(`${what} ${file} is not strict JSON: ${messageOf(err)}`);
  }
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/** A whole number of the command line (digits only, a safe integer). @throws UsageError */
export function wholeNumber(text: string, option: string): number {
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value)) throw new UsageError(`${option} must be a whole number, not ${JSON.stringify(text)}`);
  return value;
}

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Epoch ms of an ISO 8601 date-time with a zone (`2026-10-29T10:00:00Z`, `…+07:00`). @throws UsageError */
export function isoDateTime(text: string, option: string): number {
  const m = ISO_DATE_TIME.exec(text);
  const invalid = (): never => {
    throw new UsageError(`${option} must be an ISO 8601 date-time with a zone (2026-10-29T10:00:00Z), not ${JSON.stringify(text)}`);
  };
  if (m === null) return invalid();
  const [year, month, day, hour, minute, second, ms] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0', (m[7] ?? '0').padEnd(3, '0')].map(Number) as number[];
  const local = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, ms!);
  const back = new Date(local);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month! - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return invalid();
  }
  const offsetMinutes = m[8] === undefined ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  if (Math.abs(offsetMinutes) >= 24 * 60 || Number(m[10] ?? 0) >= 60) return invalid();
  return local - offsetMinutes * 60_000;
}

/**
 * Refuses an `--out` that names one of the command's input files: writing the output there would replace a private key,
 * a keyset or a feed. Compared by resolved path, and, when both exist, by device and inode (another spelling, a
 * link, a case-insensitive file system). `inputs` are `[option, file]`; an undefined file is skipped. `outOption` names
 * the output in the message (`--out` by default; `feed sign` checks each file of its `--out-dir`).
 * @throws UsageError
 */
export async function refuseOutputOverInput(
  out: string,
  inputs: ReadonlyArray<readonly [string, string | undefined]>,
  outOption = '--out',
): Promise<void> {
  const target = nodePath.resolve(out);
  const stat = async (file: string): Promise<{ dev: number; ino: number } | undefined> => {
    try {
      return await fsp.stat(file);
    } catch (err) {
      void err; // absent or unreadable: compared by path only
      return undefined;
    }
  };
  const outStat = await stat(target);
  for (const [option, file] of inputs) {
    if (file === undefined || file === '') continue;
    let same = nodePath.resolve(file) === target;
    if (!same && outStat !== undefined) {
      const inStat = await stat(file);
      same = inStat !== undefined && inStat.dev === outStat.dev && inStat.ino === outStat.ino;
    }
    if (same) throw new UsageError(`${outOption} ${out} is the ${option} file: writing it would replace that file; pick another ${outOption}`);
  }
}

/**
 * A keyset file in the frozen format (R65c), every entry a `{raw, env}` document: what installations read as
 * `keyset.json`, and what the feed carries. An entry of another shape is refused rather than skipped.
 * @throws CliError naming the file
 */
export async function readKeysetFile(file: string): Promise<KeysetDoc[]> {
  const text = await readText(file, 'keyset file');
  try {
    if (Buffer.byteLength(text, 'utf8') > KEYSET_MAX_FILE_BYTES) throw new Error(`larger than ${KEYSET_MAX_FILE_BYTES} bytes`);
    const docs = parseKeysetDocs(parseStrictJson(text));
    const bad = docs.findIndex((doc) => !isKeysetDocShape(doc));
    if (bad !== -1) throw new Error(`entry ${bad} is not {raw, env: {typ, kid, alg, sig}}`);
    return docs;
  } catch (err) {
    throw new CliError(`keyset file ${file} is not an array of root-signed keyset documents [{raw, env}]: ${messageOf(err)}`);
  }
}

/** The --root-keys file: `[{kid, use: 'root', pub}]`, root keys only, at least one. */
export async function readRootKeys(file: string): Promise<TrustedKey[]> {
  const value = await readStrictJson(file, 'root keys file');
  if (!Array.isArray(value) || value.length === 0 || !value.every((k) => isTrustedKey(k) && k.use === 'root')) {
    throw new CliError(`root keys file ${file} must be a non-empty array of {kid, use: "root", pub} (root keys only)`);
  }
  return (value as TrustedKey[]).map((k) => ({ kid: k.kid, use: k.use, pub: k.pub }));
}

// ---------------------------------------------------------------------------------------------------------
// Dev keys

export const DEV_KID_PREFIX = 'dev-';

/** tools/keys/dev/trusted.json of this checkout. */
const repositoryDevTrustedFile = (): string => nodePath.resolve(import.meta.dirname, '..', '..', 'keys', 'dev', 'trusted.json');

/**
 * The public keys of tools/keys/dev, from `file` (test seam), else the repository's file. A production root never
 * signs and a ceremony is never checked without them: a missing, unreadable, malformed or empty list is an error
 * (CliError naming "the dev public keys"), never "no dev keys".
 */
export async function devPublicKeys(file: string | undefined, why: string): Promise<string[]> {
  const source = file ?? repositoryDevTrustedFile();
  let keys: TrustedKey[];
  try {
    const text = await fsp.readFile(source, 'utf8');
    const value = parseStrictJson(text);
    if (!Array.isArray(value) || value.length === 0 || !value.every(isTrustedKey)) throw new Error('not a non-empty array of {kid, use, pub}');
    keys = value;
  } catch (err) {
    throw new CliError(`cannot read the dev public keys ${source} (${messageOf(err)}): ${why}`);
  }
  return keys.map((k) => k.pub);
}
