import { parseFeedPayload, type FeedEntry } from '@altis/crypto/feed';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/settings/registry.js';

// Ruling R1d-2: the stored `update.check.available` is a strict copy of @altis/crypto/feed's FeedEntry, and
// parseFeedPayload applies the same bounds as the setting's FEED_ENTRY. So every entry the feed parser accepts can be
// stored by the update check (Task 28) without a VALIDATION_FAILED, and the parser refuses at the setting's limits.

const ENTRY: FeedEntry = {
  version: '0.2.0-test',
  channel: 'stable',
  releasedAt: '2026-11-01',
  bootProtocol: 1,
  minUpgradeFrom: '0.0.0',
  minCodeVersionAfter: '0.1.0-test',
  minNode: '22.16.0',
  minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
  size: 12_345_678,
  sha256: 'ab'.repeat(32),
  url: 'https://updates.example.org/packages/altis-0.2.0-test.zip',
  notesUrl: null,
};

/** The value Task 28 stores after a check that found `entry`. */
const checkWith = (entry: unknown): unknown => ({ at: Date.UTC(2026, 10, 1), ok: true, error: null, seq: 7, available: entry, latest: '0.3.0-test', steppingStone: true });

const storable = (entry: unknown): boolean => SETTINGS['update.check'].schema.safeParse(checkWith(entry)).success;

function parsedEntry(entry: unknown): FeedEntry | 'refused' {
  try {
    return parseFeedPayload({ v: 1, channel: 'stable', releases: [entry], keyset: [], deviceRevocations: [] }).releases[0] as FeedEntry;
  } catch {
    return 'refused';
  }
}

describe('ruling R1d-2: a parsed FeedEntry is a valid update.check.available', () => {
  it('pushes a parsed entry, unknown fields dropped, through SETTINGS["update.check"].schema', () => {
    const parsed = parsedEntry({ ...ENTRY, firmware: { gate: '2.1' } });
    expect(parsed).toStrictEqual(ENTRY);
    expect(storable(parsed)).toBe(true);
  });

  it('entries at every bound the parser accepts are storable', () => {
    const atBounds: Partial<Record<keyof FeedEntry, unknown>>[] = [
      { version: '1.0.0-' + 'a'.repeat(58), notesUrl: 'n'.repeat(2048) },
      { url: '😀'.repeat(2048), minNode: '😀'.repeat(64) },
      { minUpgradeFrom: 'x'.repeat(64), minCodeVersionAfter: 'y', minDb: { mysql: 'm'.repeat(64), mariadb: '1', postgres: '2' } },
      { size: 0, bootProtocol: 2 },
      { size: Number.MAX_SAFE_INTEGER, bootProtocol: Number.MAX_SAFE_INTEGER, channel: 'beta', releasedAt: '2028-02-29' },
    ];
    for (const patch of atBounds) {
      const parsed = parsedEntry({ ...ENTRY, ...patch });
      expect(parsed, JSON.stringify(patch).slice(0, 80)).not.toBe('refused');
      expect(storable(parsed), JSON.stringify(patch).slice(0, 80)).toBe(true);
    }
  });

  it('the parser refuses at the limits the setting refuses (the same bounds, not looser)', () => {
    const pastBounds: Partial<Record<keyof FeedEntry, unknown>>[] = [
      { version: '1.0.0-' + 'a'.repeat(59) },
      { version: 'v1.0.0' },
      { channel: 'nightly' },
      { releasedAt: '2026-13-01' },
      { bootProtocol: 0 },
      { bootProtocol: 1.5 },
      { minUpgradeFrom: '' },
      { minNode: 'n'.repeat(65) },
      { minDb: { ...ENTRY.minDb, sqlite: '3.45' } },
      { minDb: { mysql: '8.0', mariadb: '10.6' } },
      { minDb: { ...ENTRY.minDb, mariadb: 'm'.repeat(65) } },
      { size: -1 },
      { size: 2 ** 53 },
      { sha256: 'AB'.repeat(32) },
      { sha256: 'ab'.repeat(31) },
      { url: '' },
      { url: 'u'.repeat(2049) },
      { notesUrl: '' },
      { notesUrl: '😀'.repeat(2049) },
    ];
    for (const patch of pastBounds) {
      const entry = { ...ENTRY, ...patch };
      expect(storable(entry), `setting: ${JSON.stringify(patch).slice(0, 80)}`).toBe(false);
      expect(parsedEntry(entry), `parser: ${JSON.stringify(patch).slice(0, 80)}`).toBe('refused');
    }
  });
});
