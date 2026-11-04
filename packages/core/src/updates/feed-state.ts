import type { FeedChannel } from '@altis/crypto/feed';
import { atomicWriteJson, dataPath, ensureDir, readJsonWithBak, withFileLock } from '@altis/platform';

// DATA_DIR/releases/feed-state.json: the highest freshness `seq` this installation has accepted, per channel (spec
// §9.6 "`seq` tertinggi yang pernah dilihat disimpan di DATA_DIR/releases/feed-state.json; `seq` yang lebih rendah …
// ditolak"; plan Task 20, preflight 1D-12).
//
// The file is `{stable?: {seq, at, kid?}, beta?: {seq, at, kid?}}` (`at`: epoch ms when that seq was first accepted;
// `kid`: the timestamp key whose freshness document set it, absent in a file of a release before 1d review C02). Each channel
// has its own freshness documents and its own seq, so each is protected against a rollback on its own, and switching
// channels never fails on the other channel's higher seq. A key this release does not know (a later release's
// channel, or field) is kept as it is when the file is written again.
//
// Written atomically with a `.bak` (atomicWriteJson) under `releases/feed-state.lock`, so writers in several processes
// never lose each other's raise (P6/P7); a seq is never lowered, except that a floor whose timestamp key is no longer
// trusted (a leaked key a root-signed document revoked) is replaced by the seq of the feed that revoked it, which a floor
// pushed to 2^53-1 would otherwise block for good (1d review C02). Readers take no lock: a rename is atomic.

const FILE = 'feed-state.json';
const LOCK = 'feed-state.lock';
const CHANNELS: readonly string[] = ['stable', 'beta'];

/**
 * The highest seq accepted on a channel, when it was first accepted (epoch ms), and the kid of the timestamp key that
 * signed it (absent when a release before 1d review C02 wrote it).
 */
export interface FeedSeen {
  seq: number;
  at: number;
  kid?: string;
}

type FeedStateFile = Record<string, unknown> & { stable?: FeedSeen; beta?: FeedSeen };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** A key id as the keyset documents bound it: 1 to 64 characters. */
const isKid = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 64;

function checkChannel(channel: unknown): asserts channel is FeedChannel {
  if (typeof channel !== 'string' || CHANNELS.indexOf(channel) === -1) throw new TypeError('feed state: channel must be stable or beta');
}

/**
 * The file's content: an object whose `stable` and `beta`, when present, are `{seq, at}` of whole numbers >= 0 with an
 * optional `kid`. Any other key is kept as it is. Throws for anything else, which readJsonWithBak takes as a damaged copy.
 */
function parseFeedState(raw: unknown): FeedStateFile {
  if (!isRecord(raw)) throw new Error('feed-state.json is not an object');
  const file: FeedStateFile = { ...raw };
  for (const channel of CHANNELS) {
    if (!Object.prototype.hasOwnProperty.call(raw, channel)) continue;
    const seen = raw[channel];
    if (!isRecord(seen) || !isWhole(seen['seq']) || !isWhole(seen['at'])) throw new Error(`feed-state.json: ${channel} is not {seq, at}`);
    if (seen['kid'] !== undefined && !isKid(seen['kid'])) throw new Error(`feed-state.json: ${channel}.kid is not a key id`);
    file[channel] = { ...seen, seq: seen['seq'], at: seen['at'] } as FeedSeen;
  }
  return file;
}

/**
 * The highest seq accepted on `channel` and when, or null when none was (no file, or no entry for the channel). A
 * damaged file is replaced by its `.bak` for this read.
 *
 * @throws DomainError `STATE_CORRUPT` when the file and its `.bak` both exist and neither can be used; the I/O error
 *   of anything but a missing file
 * @throws TypeError for a channel other than `stable` or `beta`
 */
export async function readFeedState(dataDir: string, channel: FeedChannel): Promise<FeedSeen | null> {
  checkChannel(channel);
  const file = await readJsonWithBak(dataPath(dataDir, 'releases', FILE), parseFeedState);
  const seen = file?.[channel];
  if (seen === undefined) return null;
  return seen.kid === undefined ? { seq: seen.seq, at: seen.at } : { seq: seen.seq, at: seen.at, kid: seen.kid };
}

/**
 * Records that `seq`, signed by the timestamp key `o.kid`, was accepted on `channel` at `now`, unless the file already
 * holds that seq or a higher one for the channel: a seq is never lowered, and `at` keeps the time the seq was first
 * accepted. A held floor whose kid `o.trusted` no longer trusts (the keys the feed was verified with) is replaced
 * whatever its seq (1d review C02); one without a kid always holds. Creates `releases/` when it is missing. Call it
 * outside any withTx callback (a file lock).
 *
 * @throws DomainError `STATE_CORRUPT` when the file cannot be read (as {@link readFeedState}) or the lock cannot be
 *   taken or was lost (`lock_timeout`, `lock_io`, `lock_lost`); `DISK_QUOTA` or the I/O error of the write
 * @throws TypeError for a channel other than `stable` or `beta`, a `seq` or `now` that is not a whole number >= 0, or a
 *   `kid` that is not a key id
 */
export async function raiseFeedSeq(
  dataDir: string,
  channel: FeedChannel,
  seq: number,
  now: number,
  o: { kid?: string; trusted?: (kid: string) => boolean } = {},
): Promise<void> {
  checkChannel(channel);
  if (!isWhole(seq)) throw new TypeError('raiseFeedSeq: seq must be a whole number >= 0');
  if (!isWhole(now)) throw new TypeError('raiseFeedSeq: now must be a whole number >= 0 (epoch ms)');
  if (o.kid !== undefined && !isKid(o.kid)) throw new TypeError('raiseFeedSeq: kid must be a key id of 1 to 64 characters');
  await ensureDir(dataPath(dataDir, 'releases'));
  const file = dataPath(dataDir, 'releases', FILE);
  await withFileLock(dataPath(dataDir, 'releases', LOCK), async (held) => {
    const current = (await readJsonWithBak(file, parseFeedState)) ?? {};
    const seen = current[channel];
    const holds = seen !== undefined && (seen.kid === undefined || o.trusted === undefined || o.trusted(seen.kid));
    if (holds && seen.seq >= seq) return;
    held.assertHeld();
    await atomicWriteJson(file, { ...current, [channel]: o.kid === undefined ? { seq, at: now } : { seq, at: now, kid: o.kid } });
  });
}
