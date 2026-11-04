import { UPLOAD_CONTEXT_NAMES } from '@altis/shared/api/files';
import { describe, expect, it } from 'vitest';
import { UPLOAD_CONTEXTS, uploadContext } from '../src/files/contexts.js';
import { SETTINGS } from '../src/settings/registry.js';

// The upload contexts (spec §7.5, decision C7) with Phase 2's (its spec §8; plan Task 2): who may upload, the largest
// declared size, the magic kinds the file must start with, and what completion does with it. Task 18 enforces
// `maxBytesSetting` and strips metadata; the table itself is pinned here.

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('UPLOAD_CONTEXTS', () => {
  it('the 1c contexts take a set of magic kinds now: ZIP only for backup and update, any type for test', () => {
    expect(uploadContext('backup')).toEqual({ name: 'backup', permission: 'system.backup.restore', maxBytes: 20 * GIB, magic: ['zip'], kind: 'staged' });
    expect(uploadContext('update')).toEqual({ name: 'update', permission: 'system.update.run', maxBytes: GIB, magic: ['zip'], kind: 'staged' });
    expect(uploadContext('test')).toEqual({ name: 'test', permission: null, maxBytes: 16 * MIB, magic: 'any', kind: 'file' });
  });

  it('Phase 2 (§8): the seven catalog contexts, with their permission, ceiling, kinds and storage', () => {
    const table = [
      ['catalog.cover', 'catalog.records.manage', 2 * MIB, ['jpeg', 'png', 'webp'], 'file'],
      ['catalog.attachment', 'catalog.records.manage', 2 * GIB, 'any', 'file'],
      // P2-18: the branch-scoped map route is the gate; an upload context cannot name a branch.
      ['catalog.floor_plan', null, 5 * MIB, ['jpeg', 'png', 'webp'], 'file'],
      ['opac.page_image', 'opac.pages.manage', 2 * MIB, ['jpeg', 'png', 'webp', 'gif'], 'file'],
      ['catalog.import', 'catalog.import.run', 512 * MIB, ['text', 'xml', 'iso2709'], 'staged'],
      ['slims.dump', 'catalog.migration.run', 4 * GIB, ['text', 'gzip'], 'staged'],
      ['slims.files', 'catalog.migration.run', 10 * GIB, ['zip'], 'staged'],
    ] as const;
    for (const [name, permission, maxBytes, magic, kind] of table) {
      const context = uploadContext(name);
      expect(context, name).toMatchObject({ name, permission, maxBytes, magic, kind });
      expect(Object.isFrozen(context), name).toBe(true);
    }
    expect(uploadContext('catalog.cover')?.magic).toEqual(['jpeg', 'png', 'webp']);
  });

  it('only catalog.attachment names a size setting (P2-22), and it is a registered setting', () => {
    const named = Object.values(UPLOAD_CONTEXTS).filter((c) => c?.maxBytesSetting !== undefined);
    expect(named.map((c) => [c!.name, c!.maxBytesSetting])).toEqual([['catalog.attachment', 'catalog.attachment.maxMb']]);
    expect(Object.hasOwn(SETTINGS, 'catalog.attachment.maxMb')).toBe(true);
  });

  it('every name of UPLOAD_CONTEXT_NAMES is a context of the test build, and nothing else is', () => {
    expect(Object.keys(UPLOAD_CONTEXTS).sort()).toEqual([...UPLOAD_CONTEXT_NAMES].sort());
    for (const name of UPLOAD_CONTEXT_NAMES) expect(uploadContext(name)?.name).toBe(name);
    expect(uploadContext('catalog')).toBeNull();
    expect(uploadContext('constructor')).toBeNull();
  });

  it('every magic set is frozen and lists known kinds once', () => {
    for (const context of Object.values(UPLOAD_CONTEXTS)) {
      if (context === undefined || context.magic === 'any') continue;
      expect(Object.isFrozen(context.magic), context.name).toBe(true);
      expect(new Set(context.magic).size, context.name).toBe(context.magic.length);
      expect(context.magic.length, context.name).toBeGreaterThan(0);
    }
  });
});
