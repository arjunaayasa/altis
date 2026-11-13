import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit-actions.js';
import { UPLOAD_CONTEXT_NAMES } from '../src/api/files.js';
import { EVENT_TYPES } from '../src/api/events.js';
import { SETTINGS_GROUPS } from '../src/api/settings.js';
import { VOCAB_LISTS } from '../src/catalog-vocab.js';
import { FIXED_CHANNEL_NAMES, ID_CHANNEL_PREFIXES } from '../src/channels.js';
import { ERROR_CODES } from '../src/errors.js';
import { permissionCatalog } from '../src/permissions.js';
import { RESERVED_EDITION_TOKENS, nameSegments, reservedTokenIn } from './support/edition-tokens.js';

// The add-on keys of the commercial editions stay out of every community registry: no permission, audit action, error
// code, event type, channel, upload context, settings group or vocabulary (list or value) uses one as its name, as the
// start of its name, or as a segment of it. A segment is what `.`, `_`, `:`, `-` or a camelCase boundary splits off,
// so a word that merely contains a token (`faceplate`) is fine. The core and server registries have their own check.

/** The registries of @altis/shared, by a name for the failure message. */
const REGISTRIES: Readonly<Record<string, readonly string[]>> = {
  permissions: permissionCatalog('test').map((def) => def.key),
  'permission modules': [...new Set(permissionCatalog('test').map((def) => def.module))],
  'audit actions': [...AUDIT_ACTIONS],
  'error codes': Object.keys(ERROR_CODES),
  'event types': [...EVENT_TYPES],
  channels: [...FIXED_CHANNEL_NAMES, ...ID_CHANNEL_PREFIXES],
  'upload contexts': [...UPLOAD_CONTEXT_NAMES],
  'settings groups': [...SETTINGS_GROUPS],
  'vocabulary lists': Object.keys(VOCAB_LISTS),
  'vocabulary values': Object.entries(VOCAB_LISTS).flatMap(([list, values]) => (values as readonly string[]).map((v) => `${list}:${v}`)),
};

describe('reserved edition tokens', () => {
  it('are the six add-on keys', () => {
    expect([...RESERVED_EDITION_TOKENS]).toEqual(['kiosk', 'iot', 'face', 'sip2', 'integrations', 'multi_branch']);
  });

  it('split a name into lower-case segments on dots, underscores, colons, hyphens and camelCase', () => {
    expect(nameSegments('catalog.isbn.arsyaEnabled')).toEqual(['catalog', 'isbn', 'arsya', 'enabled']);
    expect(nameSegments('MIGRATION_TARGET_NOT_EMPTY')).toEqual(['migration', 'target', 'not', 'empty']);
    expect(nameSegments('csv-slims-items')).toEqual(['csv', 'slims', 'items']);
    expect(nameSegments('report_format:xlsx')).toEqual(['report', 'format', 'xlsx']);
    expect(nameSegments('XMLHttpRequest')).toEqual(['xml', 'http', 'request']);
  });

  it('catch a token as a name, a prefix or a segment; multi_branch as two segments in a row', () => {
    const fakes = ['kiosk.station.open', 'iot', 'face.match', 'reports.sip2.bridge', 'system.integrations.read', 'multiBranch.manage', 'branches.multi_branch'];
    for (const name of fakes) expect(reservedTokenIn(name), name).not.toBeNull();
    expect(reservedTokenIn('kiosk.station.open')).toBe('kiosk');
    expect(reservedTokenIn('MULTI_BRANCH_LIMIT')).toBe('multi_branch');
  });

  it('do not catch a word that only contains a token', () => {
    for (const name of ['faceplate', 'surface.check', 'iota', 'kiosks', 'multi.select.branch', 'integration']) {
      expect(reservedTokenIn(name), name).toBeNull();
    }
  });
});

describe('the shared registries', () => {
  it.each(Object.entries(REGISTRIES))('%s use no reserved token as a name segment', (_registry, names) => {
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => reservedTokenIn(name) !== null)).toEqual([]);
  });

  it('a fake entry added to a list is caught', () => {
    const withFake = [...REGISTRIES['audit actions']!, 'kiosk.station.open'];
    expect(withFake.filter((name) => reservedTokenIn(name) !== null)).toEqual(['kiosk.station.open']);
  });
});
