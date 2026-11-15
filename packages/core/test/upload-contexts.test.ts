import { UPLOAD_CONTEXT_NAMES } from '@altis/shared/api/files';
import { describe, expect, it } from 'vitest';
import { UPLOAD_CONTEXTS, uploadContext } from '../src/files/contexts.js';
import { ORPHAN_UPLOAD_CONTEXTS } from '../src/files/orphan-contexts.js';
import { SETTINGS } from '../src/settings/registry.js';

// The upload contexts (spec §7.5, decision C7) with Phase 2's (its spec §8; plan Task 2) and the accreditation ones:
// who may upload, the largest declared size, the magic kinds the file must start with, and what completion does with
// it. The upload service enforces `maxBytesSetting` and strips metadata; the table itself is pinned here, with the
// registry of the contexts whose unclaimed files a housekeeping job sweeps.

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
      // The branch-scoped map route is the gate: an upload context cannot name a branch.
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

  it('the accreditation contexts: evidence files of PDF or JPEG, and a staged SLiMS dump for the usage import', () => {
    expect(uploadContext('accreditation.evidence')).toEqual({
      name: 'accreditation.evidence',
      permission: 'accreditation.workspace.manage',
      maxBytes: 100 * MIB,
      magic: ['pdf', 'jpeg'],
      kind: 'file',
      maxBytesSetting: 'accreditation.evidence.maxMb',
    });
    expect(uploadContext('accreditation.slims_dump')).toEqual({
      name: 'accreditation.slims_dump',
      permission: 'accreditation.workspace.manage',
      maxBytes: 4 * GIB,
      magic: ['text', 'gzip'],
      kind: 'staged',
    });
  });

  // ---- Komunitas K4 (stocktake) ----
  it('the stocktake code list: staged text, scanning (a branch permission) checked at the declared branch', () => {
    expect(uploadContext('stocktake.codes')).toEqual({ name: 'stocktake.codes', permission: 'stocktake.scan.use', maxBytes: 10 * MIB, magic: ['text'], kind: 'staged' });
  });

  it('a size setting lowers the ceiling of the attachment and the evidence contexts only, and each is a registered setting', () => {
    const named = Object.values(UPLOAD_CONTEXTS).filter((c) => c?.maxBytesSetting !== undefined);
    expect(named.map((c) => [c!.name, c!.maxBytesSetting])).toEqual([
      ['catalog.attachment', 'catalog.attachment.maxMb'],
      ['accreditation.evidence', 'accreditation.evidence.maxMb'],
    ]);
    for (const c of named) expect(Object.hasOwn(SETTINGS, c!.maxBytesSetting!), c!.name).toBe(true);
  });

  // ---- Komunitas (OPAC home page) ----
  it('the home page photos: JPEG of at most 500 KB and 240-2400 px a side, for whoever manages the OPAC pages; the only context that bounds dimensions', () => {
    expect(uploadContext('opac.home_photo')).toEqual({
      name: 'opac.home_photo',
      permission: 'opac.pages.manage',
      maxBytes: 500 * 1024,
      magic: ['jpeg'],
      kind: 'file',
      imageSides: { min: 240, max: 2400 },
    });
    expect(Object.values(UPLOAD_CONTEXTS).filter((c) => c?.imageSides !== undefined).map((c) => c!.name)).toEqual(['opac.home_photo']);
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

describe('ORPHAN_UPLOAD_CONTEXTS', () => {
  it('lists the four catalogue file contexts for the catalogue housekeeping, then the evidence files, member photos, card pictures and home page photos for the reports housekeeping', () => {
    expect(ORPHAN_UPLOAD_CONTEXTS).toEqual([
      { context: 'catalog.cover', sweptBy: 'catalog.housekeeping' },
      { context: 'catalog.attachment', sweptBy: 'catalog.housekeeping' },
      { context: 'catalog.floor_plan', sweptBy: 'catalog.housekeeping' },
      { context: 'opac.page_image', sweptBy: 'catalog.housekeeping' },
      { context: 'accreditation.evidence', sweptBy: 'reports.housekeeping' },
      { context: 'members.photo', sweptBy: 'reports.housekeeping' },
      { context: 'members.card_asset', sweptBy: 'reports.housekeeping' },
      { context: 'opac.home_photo', sweptBy: 'reports.housekeeping' },
    ]);
    expect(Object.isFrozen(ORPHAN_UPLOAD_CONTEXTS)).toBe(true);
  });

  it('holds file contexts only, each once: a staged upload is never a files row to sweep', () => {
    const names = ORPHAN_UPLOAD_CONTEXTS.map((entry) => entry.context);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(uploadContext(name)?.kind, name).toBe('file');
    const staged = Object.values(UPLOAD_CONTEXTS).filter((c) => c?.kind === 'staged').map((c) => c!.name);
    expect(staged.length).toBeGreaterThan(0);
    for (const name of staged) expect(names as readonly string[], name).not.toContain(name);
  });
});
