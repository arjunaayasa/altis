import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, newId } from '@altis/shared';
import { adoptRunWork } from '../src/data-files.js';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  ALTISBAK_ENTRY,
  altisbakCentralPath,
  backupImportedPath,
  backupPartPath,
  bootMarkerPath,
  dataPath,
  exportFilePath,
  extractedEntryPath,
  isReleaseStagingName,
  opKeepPath,
  releaseStagingName,
  releaseStagingPath,
  reportExportPath,
  reportExportsDir,
  reportWorkDir,
  reportWorkPath,
  reportWorkRoot,
  runWorkDir,
  runWorkPath,
  stagedReleaseFile,
  uploadPath,
  type DataArea,
  type DataPath,
} from '../src/datapath.js';

let root: string; // realpath of a temp directory
let dataDir: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-datapath-')));
  dataDir = path.join(root, 'altis-data');
  await fsp.mkdir(dataDir);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const ULID = '01JBX5ZK3M8Q4R7T9V0W2Y6A1C';
const SHA256 = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

/** The error `fn` throws, or undefined. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(fn: () => unknown): void {
  const error = thrown(fn);
  expect(isDomainError(error)).toBe(true);
  expect(error).toMatchObject({ code: 'INVALID_PATH_SEGMENT', status: 500 });
}

describe('dataPath: accepted segments', () => {
  it('returns the area directory itself when there are no segments', () => {
    expect(dataPath(dataDir, 'releases')).toBe(path.join(dataDir, 'releases'));
  });

  it('accepts a ULID', () => {
    expect(dataPath(dataDir, 'ops', ULID)).toBe(path.join(dataDir, 'ops', ULID));
  });

  it.each(['1.2.3', '0.0.1', '10.20.30-rc.1', '1.0.0-alpha+build.5'])('accepts the SemVer %s', (version) => {
    expect(dataPath(dataDir, 'releases', version)).toBe(path.join(dataDir, 'releases', version));
  });

  it('accepts a 64-hex digest', () => {
    expect(dataPath(dataDir, 'cache', SHA256)).toBe(path.join(dataDir, 'cache', SHA256));
  });

  it('accepts a <digits>-<digits> pair', () => {
    expect(dataPath(dataDir, 'backups', '12-345')).toBe(path.join(dataDir, 'backups', '12-345'));
  });

  it('joins several segments', () => {
    expect(dataPath(dataDir, 'releases', '1.2.3', 'manifest.json')).toBe(
      path.join(dataDir, 'releases', '1.2.3', 'manifest.json'),
    );
    expect(dataPath(dataDir, 'ops', ULID, 'op.json')).toBe(path.join(dataDir, 'ops', ULID, 'op.json'));
  });

  const LITERALS = [
    'current.json',
    'current.lock',
    'schema-meta.json',
    'keyset.json',
    'feed-state.json',
    'revoked.json',
    'migrate.lock',
    'rotate.lock',
    'install-run.lock',
    'op.json',
    'maintenance.json',
    'data-epoch',
    'install-session.json',
    'altis.log',
    'audit-anchor.log',
    'altis.sqlite',
    'manifest.json',
    'manifest.sig',
    '.complete',
  ];

  it.each(LITERALS)('accepts the literal %s in a regular area', (name) => {
    expect(dataPath(dataDir, 'tmp', name)).toBe(path.join(dataDir, 'tmp', name));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('accepts the rotated log altis.log.%i (ruling R3)', (n) => {
    expect(dataPath(dataDir, 'logs', `altis.log.${n}`)).toBe(path.join(dataDir, 'logs', `altis.log.${n}`));
  });

  it.each(['altis.log.0', 'altis.log.10', 'altis.log.', 'altis.log.a', 'altis.log.01', 'altis.log.1.gz', 'Altis.log'])(
    'rejects %s',
    (name) => {
      expectInvalid(() => dataPath(dataDir, 'logs', name));
    },
  );

  it('works when DATA_DIR does not exist yet', () => {
    const later = path.join(root, 'not', 'yet', 'altis-data');
    expect(dataPath(later, 'db', 'altis.sqlite')).toBe(path.join(later, 'db', 'altis.sqlite'));
  });

  it('resolves a relative DATA_DIR against the working directory', async () => {
    const real = await fsp.realpath(process.cwd());
    expect(dataPath('altis-data-rel', 'tmp')).toBe(path.join(real, 'altis-data-rel', 'tmp'));
  });
});

describe('dataPath: the root area', () => {
  it('is DATA_DIR itself', () => {
    expect(dataPath(dataDir, 'root')).toBe(dataDir);
  });

  it.each(['config.json', 'config.lock', 'install.lock', 'altis-data-dir.txt', 'install-code.txt'])('accepts the literal %s', (name) => {
    expect(dataPath(dataDir, 'root', name)).toBe(path.join(dataDir, name));
  });

  it.each([
    'current.json',
    'altis.sqlite',
    'altis.log',
    'altis.log.1',
    '.complete',
    'op.json',
    'rotate.lock',
    'install-run.lock',
  ])(
    'rejects the area literal %s',
    (name) => {
      expectInvalid(() => dataPath(dataDir, 'root', name));
    },
  );

  it.each([ULID, '1.2.3', SHA256, '1-2'])('rejects the typed segment %s', (segment) => {
    expectInvalid(() => dataPath(dataDir, 'root', segment));
  });

  it.each(['config.json', 'config.lock', 'install.lock', 'altis-data-dir.txt', 'install-code.txt', 'config.json.bak-1767225600000'])('rejects %s in every other area', (name) => {
    const areas: DataArea[] = ['releases', 'ops', 'uploads', 'backups', 'logs', 'cache', 'tmp', 'db', 'exports'];
    for (const area of areas) expectInvalid(() => dataPath(dataDir, area, name));
  });
});

describe('dataPath: rejected segments', () => {
  it.each([
    ['..'],
    ['.'],
    ['a/b'],
    ['a\\b'],
    ['../x'],
    ['x.json'],
    [''],
    ['\0'],
    ['current.json\0'],
    ['current.json/'],
    [' current.json'],
    ['CURRENT.JSON'],
    ['01jbx5zk3m8q4r7t9v0w2y6a1c'], // lower-case ULID is not canonical
    ['01JBX5ZK3M8Q4R7T9V0W2Y6A1'], // 25 characters
    ['1.2'],
    ['v1.2.3'],
    ['01.2.3'],
    ['1-'],
    ['-1'],
    ['1--2'],
    ['1-2-3'],
    [`${SHA256}0`],
    [SHA256.slice(1)],
    [SHA256.toUpperCase()],
    ['C:'],
    ['~'],
  ])('rejects %j with INVALID_PATH_SEGMENT', (segment) => {
    expectInvalid(() => dataPath(dataDir, 'tmp', segment));
  });

  it('rejects a bad segment anywhere in the list', () => {
    expectInvalid(() => dataPath(dataDir, 'releases', '1.2.3', '..', 'manifest.json'));
    expectInvalid(() => dataPath(dataDir, 'releases', '1.2.3', 'manifest.json', ''));
  });

  it('rejects an unknown area, whatever the type system says', () => {
    expectInvalid(() => dataPath(dataDir, 'secrets' as DataArea));
    expectInvalid(() => dataPath(dataDir, '..' as DataArea));
    expectInvalid(() => dataPath(dataDir, '' as DataArea));
    expectInvalid(() => dataPath(dataDir, 'toString' as DataArea));
  });

  it('rejects a segment that is not a string', () => {
    expectInvalid(() => dataPath(dataDir, 'tmp', 5 as unknown as string));
    expectInvalid(() => dataPath(dataDir, 'tmp', undefined as unknown as string));
    expectInvalid(() => dataPath(dataDir, 'tmp', null as unknown as string));
    expectInvalid(() => dataPath(dataDir, 'tmp', ['..'] as unknown as string));
  });

  it('carries a bilingual detail and a bounded copy of the offending segment', () => {
    const error = thrown(() => dataPath(dataDir, 'tmp', `x${'y'.repeat(500)}`)) as {
      detail: string;
      meta: { area: string; segment: string };
    };
    expect(error.detail).toContain(' / ');
    expect(error.meta.area).toBe('tmp');
    expect(error.meta.segment.length).toBeLessThanOrEqual(80);
  });
});

describe('dataPath: containment', () => {
  it('returns a path under realpath(dataDir)/<area> when DATA_DIR is reached through a symlink', async () => {
    const link = path.join(root, 'link-to-data');
    await fsp.symlink(dataDir, link);
    expect(dataPath(link, 'uploads', ULID)).toBe(path.join(dataDir, 'uploads', ULID));
    expect(dataPath(path.join(link, '..', 'link-to-data'), 'root', 'config.json')).toBe(path.join(dataDir, 'config.json'));
  });

  describe('an area directory that is a symlink (spec §7.5: the real path must stay under DATA_DIR/<area>)', () => {
    it('refuses an area that points to another volume, with reason area_escape', async () => {
      await fsp.mkdir(path.join(root, 'bigdisk', 'uploads'), { recursive: true });
      await fsp.symlink(path.join(root, 'bigdisk', 'uploads'), path.join(dataDir, 'uploads'));
      for (const call of [
        () => dataPath(dataDir, 'uploads', ULID),
        () => dataPath(dataDir, 'uploads'),
        () => uploadPath(dataDir, newId(Date.UTC(2026, 9, 26))),
      ]) {
        expectInvalid(call);
        expect(thrown(call)).toMatchObject({ meta: { area: 'uploads', reason: 'area_escape' } });
      }
    });

    it('refuses an area that points to a sibling area or to another folder inside DATA_DIR', async () => {
      await fsp.mkdir(path.join(dataDir, 'cache'));
      await fsp.symlink(path.join(dataDir, 'cache'), path.join(dataDir, 'tmp'));
      await fsp.mkdir(path.join(dataDir, 'ops-evil'));
      await fsp.symlink(path.join(dataDir, 'ops-evil'), path.join(dataDir, 'ops'));
      expect(thrown(() => dataPath(dataDir, 'tmp', 'op.json'))).toMatchObject({ meta: { reason: 'area_escape' } });
      expect(thrown(() => dataPath(dataDir, 'ops', ULID))).toMatchObject({ meta: { reason: 'area_escape' } });
    });

    it('refuses a dangling area link', async () => {
      await fsp.symlink(path.join(root, 'nowhere'), path.join(dataDir, 'backups'));
      expect(thrown(() => dataPath(dataDir, 'backups', '1-2'))).toMatchObject({ meta: { reason: 'area_escape' } });
    });

    it('still accepts DATA_DIR itself behind a link, and an area that does not exist yet', async () => {
      const link = path.join(root, 'link-to-data');
      await fsp.symlink(dataDir, link);
      expect(dataPath(link, 'uploads', ULID)).toBe(path.join(dataDir, 'uploads', ULID));
      expect(dataPath(dataDir, 'uploads', ULID)).toBe(path.join(dataDir, 'uploads', ULID)); // no uploads folder yet
    });
  });

  it('refuses a symlink inside an area that leaves the area', async () => {
    await fsp.mkdir(path.join(dataDir, 'ops'));
    await fsp.mkdir(path.join(root, 'elsewhere'));
    await fsp.symlink(path.join(root, 'elsewhere'), path.join(dataDir, 'ops', ULID));
    expectInvalid(() => dataPath(dataDir, 'ops', ULID, 'op.json'));
    expectInvalid(() => dataPath(dataDir, 'ops', ULID));
  });

  it('refuses a dangling symlink inside an area whose target is outside it', async () => {
    await fsp.mkdir(path.join(dataDir, 'ops'));
    await fsp.symlink(path.join(root, 'nowhere', 'yet'), path.join(dataDir, 'ops', ULID));
    expectInvalid(() => dataPath(dataDir, 'ops', ULID, 'op.json'));
  });

  it('accepts a symlink inside an area that stays inside it', async () => {
    await fsp.mkdir(path.join(dataDir, 'releases', '1.2.3'), { recursive: true });
    await fsp.symlink(path.join(dataDir, 'releases', '1.2.3'), path.join(dataDir, 'releases', '1.2.4'));
    expect(dataPath(dataDir, 'releases', '1.2.4', 'manifest.json')).toBe(
      path.join(dataDir, 'releases', '1.2.4', 'manifest.json'),
    );
  });

  it('refuses config.json when it is a symlink out of DATA_DIR', async () => {
    await fsp.writeFile(path.join(root, 'secret'), '');
    await fsp.symlink(path.join(root, 'secret'), path.join(dataDir, 'config.json'));
    expectInvalid(() => dataPath(dataDir, 'root', 'config.json'));
  });

  it('does not treat a sibling directory with the same name prefix as inside the area', async () => {
    await fsp.mkdir(path.join(dataDir, 'ops-evil'));
    await fsp.mkdir(path.join(dataDir, 'ops'));
    await fsp.symlink(path.join(dataDir, 'ops-evil'), path.join(dataDir, 'ops', ULID));
    expectInvalid(() => dataPath(dataDir, 'ops', ULID, 'op.json'));
  });
});

describe('uploadPath', () => {
  it('derives uploads/<yyyy>/<mm>/<id> from the ULID time, in UTC', () => {
    const id = newId(Date.UTC(2026, 9, 26, 12, 0, 0)); // 2026-10-26
    expect(uploadPath(dataDir, id)).toBe(path.join(dataDir, 'uploads', '2026', '10', id));
  });

  it('pads the month and uses UTC at the month boundary, whatever the local time zone', () => {
    const before = process.env['TZ'];
    try {
      for (const tz of ['Asia/Jakarta', 'Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
        process.env['TZ'] = tz;
        const last = newId(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
        const first = newId(Date.UTC(2027, 0, 1, 0, 0, 0, 0));
        expect(uploadPath(dataDir, last)).toBe(path.join(dataDir, 'uploads', '2026', '12', last));
        expect(uploadPath(dataDir, first)).toBe(path.join(dataDir, 'uploads', '2027', '01', first));
      }
    } finally {
      if (before === undefined) delete process.env['TZ'];
      else process.env['TZ'] = before;
    }
  });

  it('is under realpath(dataDir)/uploads', async () => {
    const link = path.join(root, 'link');
    await fsp.symlink(dataDir, link);
    const id = newId(Date.UTC(2026, 0, 5));
    expect(uploadPath(link, id)).toBe(path.join(dataDir, 'uploads', '2026', '01', id));
  });

  it.each([
    [''],
    ['..'],
    ['../../etc/passwd'],
    ['01jbx5zk3m8q4r7t9v0w2y6a1c'],
    ['01JBX5ZK3M8Q4R7T9V0W2Y6A1C/x'],
    ['9ZZZZZZZZZZZZZZZZZZZZZZZZZ'],
    ['\0'],
  ])('rejects %j as an id', (id) => {
    expectInvalid(() => uploadPath(dataDir, id));
  });

  it('rejects an id that is not a string', () => {
    expectInvalid(() => uploadPath(dataDir, 5 as unknown as string));
    expectInvalid(() => uploadPath(dataDir, undefined as unknown as string));
  });

  it('refuses an uploads directory entry that is a symlink out of the area', async () => {
    const id = newId(Date.UTC(2026, 9, 26));
    await fsp.mkdir(path.join(dataDir, 'uploads', '2026'), { recursive: true });
    await fsp.mkdir(path.join(root, 'elsewhere'));
    await fsp.symlink(path.join(root, 'elsewhere'), path.join(dataDir, 'uploads', '2026', '10'));
    expectInvalid(() => uploadPath(dataDir, id));
  });
});

describe('DataPath (Phase 1c Task 2)', () => {
  it('is what dataPath and uploadPath return: a branded string, usable wherever a string is', () => {
    const p = dataPath(dataDir, 'tmp', 'op.json');
    expectTypeOf(p).toEqualTypeOf<DataPath>();
    expectTypeOf(uploadPath(dataDir, ULID)).toEqualTypeOf<DataPath>();
    expectTypeOf(p).toExtend<string>();
    // A plain string is not a DataPath: a computed path needs a visible cast.
    expectTypeOf<string>().not.toExtend<DataPath>();
    expect(typeof p).toBe('string');
  });
});

describe('dataPath: the 1c literals (Task 2, S14)', () => {
  const NEW_LITERALS = [
    'tables',
    'blobs',
    'keep',
    'downloads',
    'src',
    '.work',
    'archive.altisbak',
    'archive.central', // Task 12, ruling R1c-6: the archive writer's central-directory sidecar
    'prepared.json',
    'upload.bin',
    'upload.midstate',
    'snapshot.sqlite',
    'restore.sqlite',
    'pre-restore.sqlite',
    'sqlite.lock',
    'sqlite-owner.json',
    'step.lock',
    'report.json',
    'cron-seen.json',
    'cron.lock',
    'cron-flight.json',
    'install-claims.json',
    'altisbak.json',
    'corrupt-reported',
    'install-session.lock', // Task 10
    'parts.jsonl', // Task 11
    'control-request', // final review: a cancel, takeover or resume waiting for ops/step.lock
  ];

  it.each(NEW_LITERALS)('accepts %s in a regular area', (name) => {
    expect(dataPath(dataDir, 'tmp', name)).toBe(path.join(dataDir, 'tmp', name));
  });

  it.each(NEW_LITERALS)('rejects %s in the root area', (name) => {
    expectInvalid(() => dataPath(dataDir, 'root', name));
  });

  it('accepts the backup, blob, restore and install paths the 1c tasks build', () => {
    expect(dataPath(dataDir, 'backups', ULID, 'tables')).toBe(path.join(dataDir, 'backups', ULID, 'tables'));
    expect(dataPath(dataDir, 'backups', 'blobs', SHA256)).toBe(path.join(dataDir, 'backups', 'blobs', SHA256));
    expect(dataPath(dataDir, 'db', ULID, 'restore.sqlite')).toBe(path.join(dataDir, 'db', ULID, 'restore.sqlite'));
    expect(dataPath(dataDir, 'root', 'install-code.txt')).toBe(path.join(dataDir, 'install-code.txt'));
    expect(dataPath(dataDir, 'root', 'config.json.bak-1767225600000')).toBe(path.join(dataDir, 'config.json.bak-1767225600000'));
  });

  it('never accepts a table name or a part file name: those come from the typed builders only (C10)', () => {
    expectInvalid(() => dataPath(dataDir, 'backups', ULID, 'tables', 'branches'));
    expectInvalid(() => dataPath(dataDir, 'backups', ULID, 'tables', '00001.jsonl.gz'));
    expectInvalid(() => dataPath(dataDir, 'backups', ULID, 'imported-branches.jsonl.gz'));
    expectInvalid(() => dataPath(dataDir, 'ops', ULID, 'keep', 'branches.jsonl.gz'));
  });

  it('accepts install-code.txt in the root area only (spec §7.7: DATA_DIR/install-code.txt)', () => {
    expectInvalid(() => dataPath(dataDir, 'tmp', 'install-code.txt'));
    expectInvalid(() => dataPath(dataDir, 'ops', 'install-code.txt'));
  });

  it.each([
    'config.json.bak-176722560000', // 12 digits
    'config.json.bak-17672256000001', // 14 digits
    'config.json.bak-',
    'config.json.bak',
    'config.json.bak-1767225600000.tmp',
    'config.json.bak-176722560000x',
    'config.json.bak-1767225600000/',
    'config.json.bak-\u0661\u0667\u0666\u0667\u0662\u0662\u0665\u0666\u0660\u0660\u0660\u0660\u0660', // Arabic-Indic digits
  ])('rejects %j in the root area', (name) => {
    expectInvalid(() => dataPath(dataDir, 'root', name));
  });
});

describe('typed backup and op paths (C10)', () => {
  const T: ReadonlySet<string> = new Set(['branches', 'staff_users', 'a', `t${'x'.repeat(59)}`]);
  const OP = '01JBX5ZK3M8Q4R7T9V0W2Y6A1D';

  it('backupPartPath: backups/<id>/tables/<table>/<part, 5 digits>.jsonl.gz', () => {
    const p = backupPartPath(dataDir, ULID, 'branches', 7, T);
    expect(p).toBe(path.join(dataDir, 'backups', ULID, 'tables', 'branches', '00007.jsonl.gz'));
    expect(p.endsWith(path.join('backups', ULID, 'tables', 'branches', '00007.jsonl.gz'))).toBe(true);
    expectTypeOf(p).toEqualTypeOf<DataPath>();
    expect(backupPartPath(dataDir, ULID, 'staff_users', 0, T)).toBe(
      path.join(dataDir, 'backups', ULID, 'tables', 'staff_users', '00000.jsonl.gz'),
    );
    expect(backupPartPath(dataDir, ULID, 'a', 99_999, T)).toBe(path.join(dataDir, 'backups', ULID, 'tables', 'a', '99999.jsonl.gz'));
    const longest = `t${'x'.repeat(59)}`; // 60 characters
    expect(backupPartPath(dataDir, ULID, longest, 1, T)).toBe(path.join(dataDir, 'backups', ULID, 'tables', longest, '00001.jsonl.gz'));
  });

  it.each([
    ['../x'],
    ['Branches'],
    ['_branches'],
    ['1branches'],
    ['branches/x'],
    ['branches\0'],
    [''],
    [`t${'x'.repeat(60)}`], // 61 characters
  ])('refuses the table %j with INVALID_PATH_SEGMENT, even when the registry names it', (table) => {
    expectInvalid(() => backupPartPath(dataDir, ULID, table, 1, new Set([...T, table])));
    expectInvalid(() => backupImportedPath(dataDir, ULID, table, new Set([...T, table])));
    expectInvalid(() => opKeepPath(dataDir, OP, table, new Set([...T, table])));
  });

  it('refuses a table that has the right shape but is not in the registry', () => {
    expectInvalid(() => backupPartPath(dataDir, ULID, 'nope', 1, T));
    expectInvalid(() => backupImportedPath(dataDir, ULID, 'nope', T));
    expectInvalid(() => opKeepPath(dataDir, OP, 'nope', T));
  });

  it('refuses a table that is not a string', () => {
    expectInvalid(() => backupPartPath(dataDir, ULID, 5 as unknown as string, 1, T));
    expectInvalid(() => opKeepPath(dataDir, OP, undefined as unknown as string, T));
  });

  it.each([[100_000], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['1' as unknown as number]])(
    'backupPartPath refuses the part %j',
    (part) => {
      expectInvalid(() => backupPartPath(dataDir, ULID, 'branches', part, T));
    },
  );

  it.each([['../x'], [''], ['01jbx5zk3m8q4r7t9v0w2y6a1c'], ['manifest.json'], ['1.2.3'], [SHA256], ['1-2']])(
    'refuses the backup or op id %j (a ULID only)',
    (id) => {
      expectInvalid(() => backupPartPath(dataDir, id, 'branches', 1, T));
      expectInvalid(() => backupImportedPath(dataDir, id, 'branches', T));
      expectInvalid(() => opKeepPath(dataDir, id, 'branches', T));
      expectInvalid(() => extractedEntryPath(dataDir, id, 'manifest.json', T));
    },
  );

  it('backupImportedPath: backups/<id>/imported-<table>.jsonl.gz', () => {
    expect(backupImportedPath(dataDir, ULID, 'branches', T)).toBe(path.join(dataDir, 'backups', ULID, 'imported-branches.jsonl.gz'));
    expectInvalid(() => backupImportedPath(dataDir, ULID, '../x', T));
  });

  it('opKeepPath: ops/<opId>/keep/<table>.jsonl.gz', () => {
    expect(opKeepPath(dataDir, OP, 'staff_users', T)).toBe(path.join(dataDir, 'ops', OP, 'keep', 'staff_users.jsonl.gz'));
    expectInvalid(() => opKeepPath(dataDir, OP, 'x/../y', T));
  });

  it('keeps the containment check: a symlinked backup folder that leaves the area is refused', async () => {
    await fsp.mkdir(path.join(dataDir, 'backups'), { recursive: true });
    await fsp.mkdir(path.join(root, 'elsewhere'));
    await fsp.symlink(path.join(root, 'elsewhere'), path.join(dataDir, 'backups', ULID));
    expect(thrown(() => backupPartPath(dataDir, ULID, 'branches', 1, T))).toMatchObject({
      code: 'INVALID_PATH_SEGMENT',
      meta: { reason: 'escapes_area' },
    });
  });
});

describe('archive entries (S14)', () => {
  const T: ReadonlySet<string> = new Set(['branches', 'staff_users', 'a_b9']);
  const OP = '01JBX5ZK3M8Q4R7T9V0W2Y6A1D';

  it.each(['altisbak.json', 'manifest.json', 'tables/branches/00001.jsonl.gz', 'tables/a_b9/99999.jsonl.gz', `blobs/${SHA256}`])(
    'ALTISBAK_ENTRY accepts %s',
    (entry) => {
      expect(ALTISBAK_ENTRY.test(entry)).toBe(true);
    },
  );

  it.each([
    'tables/x/../y',
    'tables/branches/1.jsonl.gz',
    'tables/branches/000001.jsonl.gz',
    'tables/Branches/00001.jsonl.gz',
    '/manifest.json',
    './manifest.json',
    'manifest.json/',
    'tables\\branches\\00001.jsonl.gz',
    `blobs/${SHA256.toUpperCase()}`,
    `blobs/${SHA256}/x`,
    'C:/manifest.json',
    'manifest.json\0',
    'manifest.json\n',
    'other.json',
  ])('ALTISBAK_ENTRY refuses %j', (entry) => {
    expect(ALTISBAK_ENTRY.test(entry)).toBe(false);
  });

  it('extractedEntryPath: tmp/<opId>/src/<entry>', () => {
    const p = extractedEntryPath(dataDir, OP, 'tables/branches/00001.jsonl.gz', T);
    expect(p).toBe(path.join(dataDir, 'tmp', OP, 'src', 'tables', 'branches', '00001.jsonl.gz'));
    expectTypeOf(p).toEqualTypeOf<DataPath>();
    expect(extractedEntryPath(dataDir, OP, 'manifest.json', T)).toBe(path.join(dataDir, 'tmp', OP, 'src', 'manifest.json'));
    expect(extractedEntryPath(dataDir, OP, 'altisbak.json', T)).toBe(path.join(dataDir, 'tmp', OP, 'src', 'altisbak.json'));
    expect(extractedEntryPath(dataDir, OP, `blobs/${SHA256}`, T)).toBe(path.join(dataDir, 'tmp', OP, 'src', 'blobs', SHA256));
  });

  it.each(['tables/x/../y', '../manifest.json', 'tables/nope/00001.jsonl.gz', '', 'x', 'manifest.json\n', 5 as unknown as string])(
    'extractedEntryPath refuses %j with INVALID_PATH_SEGMENT',
    (entry) => {
      expectInvalid(() => extractedEntryPath(dataDir, OP, entry, T));
    },
  );

  it('altisbakCentralPath: archive.central beside an archive.altisbak (ruling R1c-6)', () => {
    const download = dataPath(dataDir, 'backups', ULID, 'downloads', OP, 'archive.altisbak');
    const p = altisbakCentralPath(download);
    expect(p).toBe(path.join(dataDir, 'backups', ULID, 'downloads', OP, 'archive.central'));
    expectTypeOf(p).toEqualTypeOf<DataPath>();
    expect(altisbakCentralPath(dataPath(dataDir, 'tmp', OP, 'archive.altisbak'))).toBe(path.join(dataDir, 'tmp', OP, 'archive.central'));
  });

  it('altisbakCentralPath refuses anything but an archive.altisbak path built in a known DATA_DIR', () => {
    expectInvalid(() => altisbakCentralPath(dataPath(dataDir, 'backups', ULID, 'prepared.json')));
    expectInvalid(() => altisbakCentralPath(dataPath(dataDir, 'backups', ULID, 'archive.central')));
    // computed paths, cast: outside any DATA_DIR this process built a path in, in no area, through a folder name
    // dataPath would refuse, or not a string at all
    const unknownRoot = path.join(root, 'elsewhere', 'backups', ULID, 'archive.altisbak');
    expectInvalid(() => altisbakCentralPath(unknownRoot as DataPath));
    dataPath(dataDir, 'tmp'); // DATA_DIR known to this process
    expectInvalid(() => altisbakCentralPath(path.join(dataDir, 'archive.altisbak') as DataPath));
    expectInvalid(() => altisbakCentralPath(path.join(dataDir, 'nowhere', 'archive.altisbak') as DataPath));
    expectInvalid(() => altisbakCentralPath(path.join(dataDir, 'backups', 'not a ulid', 'archive.altisbak') as DataPath));
    expectInvalid(() => altisbakCentralPath(5 as unknown as DataPath));
  });
});

// 1d Task 2: the update's files in `releases` (spec §9.3, §9.6, D1d-16).
describe('releases: boot lock, boot markers, staging folders (1d)', () => {
  const V = '0.2.0-test';
  const OP = ULID;
  const releases = (...segments: string[]): string => path.join(dataDir, 'releases', ...segments);

  it.each(['boot.lock', 'clock.json', 'clock.lock', 'keyset.lock', 'feed-state.lock', 'boot'])('dataPath accepts the literal %s in releases', (name) => {
    expect(dataPath(dataDir, 'releases', name)).toBe(releases(name));
  });

  it('bootMarkerPath is releases/boot/<v>/<pid>-<startMs>', () => {
    const p = bootMarkerPath(dataDir, V, 123, 1767225600000);
    expect(p).toBe(releases('boot', V, '123-1767225600000'));
    expect(p.endsWith(path.join('releases', 'boot', '0.2.0-test', '123-1767225600000'))).toBe(true);
    expectTypeOf(p).toEqualTypeOf<DataPath>();
  });

  it.each([
    ['a version that is not SemVer', 'next', 123, 1],
    ['a version with a separator', '../0.2.0', 123, 1],
    ['pid 0', V, 0, 1],
    ['a negative pid', V, -1, 1],
    ['a fractional pid', V, 1.5, 1],
    ['a negative start time', V, 123, -1],
    ['a fractional start time', V, 123, 1.5],
    ['an unsafe start time', V, 123, 2 ** 53],
  ])('bootMarkerPath refuses %s with INVALID_PATH_SEGMENT', (_what, version, pid, startMs) => {
    expectInvalid(() => bootMarkerPath(dataDir, version, pid, startMs));
  });

  it('releaseStagingName is .tmp-<v>-<opId>', () => {
    expect(releaseStagingName(V, OP)).toBe(`.tmp-0.2.0-test-${OP}`);
    expect(releaseStagingName('1.0.0+build.5', OP)).toBe(`.tmp-1.0.0+build.5-${OP}`);
  });

  it.each([
    ['next', OP],
    [V, 'not-a-ulid'],
    [V, OP.toLowerCase()],
  ])('releaseStagingName refuses version %j with op id %j', (version, opId) => {
    expectInvalid(() => releaseStagingName(version, opId));
  });

  it('releaseStagingPath is releases/.tmp-<v>-<opId>[/package.zip | /download.json | /release]', () => {
    expect(releaseStagingPath(dataDir, V, OP)).toBe(releases(`.tmp-${V}-${OP}`));
    const zip = releaseStagingPath(dataDir, V, OP, 'package.zip');
    expect(zip.endsWith(path.join('releases', `.tmp-0.2.0-test-${OP}`, 'package.zip'))).toBe(true);
    expectTypeOf(zip).toEqualTypeOf<DataPath>();
    expect(releaseStagingPath(dataDir, V, OP, 'download.json')).toBe(releases(`.tmp-${V}-${OP}`, 'download.json'));
    expect(releaseStagingPath(dataDir, V, OP, 'release')).toBe(releases(`.tmp-${V}-${OP}`, 'release'));
  });

  it('releaseStagingPath refuses any other file name, and a version or op id that releaseStagingName refuses', () => {
    expectInvalid(() => releaseStagingPath(dataDir, V, OP, 'manifest.json' as 'release'));
    expectInvalid(() => releaseStagingPath(dataDir, V, OP, '..' as 'release'));
    expectInvalid(() => releaseStagingPath(dataDir, 'next', OP, 'package.zip'));
    expectInvalid(() => releaseStagingPath(dataDir, V, 'x', 'package.zip'));
  });

  it('the staging folder names are not dataPath segments (only the typed builders make them)', () => {
    expectInvalid(() => dataPath(dataDir, 'releases', `.tmp-${V}-${OP}`));
    expectInvalid(() => dataPath(dataDir, 'releases', 'package.zip'));
    expectInvalid(() => dataPath(dataDir, 'releases', 'download.json'));
  });

  it('isReleaseStagingName takes a staging folder name apart', () => {
    expect(isReleaseStagingName(`.tmp-0.2.0-test-${OP}`)).toEqual({ version: '0.2.0-test', opId: OP });
    expect(isReleaseStagingName(`.tmp-1.0.0-rc.1+b-7-${OP}`)).toEqual({ version: '1.0.0-rc.1+b-7', opId: OP });
    expect(isReleaseStagingName(releaseStagingName('3.4.5', OP))).toEqual({ version: '3.4.5', opId: OP });
  });

  it.each([
    '.tmp-x',
    `.tmp-${OP}`,
    `.tmp--${OP}`,
    `.tmp-next-${OP}`,
    `.tmp-0.2.0-test-${OP.toLowerCase()}`,
    `.tmp-0.2.0-test-${OP}x`,
    `tmp-0.2.0-test-${OP}`,
    `0.2.0-test`,
    `.tmp-0.2.0-test_${OP}`,
    '',
    5 as unknown as string,
  ])('isReleaseStagingName(%j) is null', (name) => {
    expect(isReleaseStagingName(name)).toBeNull();
  });

  it('stagedReleaseFile is releases/.tmp-<v>-<opId>/release/<relPath>', () => {
    const p = stagedReleaseFile(dataDir, V, OP, 'public/admin/assets/a.js');
    expect(p).toBe(releases(`.tmp-${V}-${OP}`, 'release', 'public', 'admin', 'assets', 'a.js'));
    expectTypeOf(p).toEqualTypeOf<DataPath>();
    expect(stagedReleaseFile(dataDir, V, OP, 'server.mjs')).toBe(releases(`.tmp-${V}-${OP}`, 'release', 'server.mjs'));
    expect(stagedReleaseFile(dataDir, V, OP, '.complete')).toBe(releases(`.tmp-${V}-${OP}`, 'release', '.complete'));
    expect(stagedReleaseFile(dataDir, V, OP, 'public/THIRD_PARTY_NOTICES.txt')).toBe(
      releases(`.tmp-${V}-${OP}`, 'release', 'public', 'THIRD_PARTY_NOTICES.txt'),
    );
  });

  it.each([
    '../x',
    'public/../../x',
    '/x',
    'a\\b',
    'a\u0000b',
    'C:x',
    'c:/x',
    'a//b',
    'a/',
    '.hidden',
    'public/.hidden',
    'public/.complete',
    '.',
    'a/./b',
    '',
    'a\nb',
    5 as unknown as string,
  ])('stagedReleaseFile refuses %j with INVALID_PATH_SEGMENT', (relPath) => {
    expectInvalid(() => stagedReleaseFile(dataDir, V, OP, relPath));
  });

  // Windows rewrites a name that ends in '.' or a space (`server.mjs.` is `server.mjs`), and opens a device for a
  // reserved name whatever its extension (`public/con.js` is the console): a release staged on a Windows PC must
  // never hold one, or two manifest entries land in one file, or a write goes to a device.
  it.each([
    'server.mjs.',
    'server.mjs ',
    'public/a.js.',
    'public/a. ',
    'public./a.js',
    'public /a.js',
    'con',
    'CON',
    'public/con.js',
    'public/Con.tar.gz',
    'prn',
    'aux.css',
    'nul',
    'NUL.txt',
    'nul .txt',
    'com0',
    'COM1.js',
    'com9',
    'lpt0.x',
    'LPT9',
    'com\u00b9',
    'lpt\u00b2.js',
    'conin$',
    'CONOUT$.log',
    'public/aux/x.js',
  ])('stagedReleaseFile refuses the Windows-unsafe %j with INVALID_PATH_SEGMENT', (relPath) => {
    expectInvalid(() => stagedReleaseFile(dataDir, V, OP, relPath));
  });

  it.each([
    'public/console.js',
    'public/icon.svg',
    'public/con-1a2b.js',
    'public/conx.js',
    'public/com10.js',
    'public/lpt.js',
    'public/auxiliary/a.js',
    'public/a.b.c',
    'public/a b.js',
    'public/nul_.txt',
  ])('stagedReleaseFile accepts the ordinary name %j', (relPath) => {
    expect(stagedReleaseFile(dataDir, V, OP, relPath)).toBe(releases(`.tmp-${V}-${OP}`, 'release', ...relPath.split('/')));
  });

  it('stagedReleaseFile refuses a staging folder whose version or op id is refused', () => {
    expectInvalid(() => stagedReleaseFile(dataDir, 'next', OP, 'server.mjs'));
    expectInvalid(() => stagedReleaseFile(dataDir, V, 'x', 'server.mjs'));
  });

  it('stagedReleaseFile refuses a path that leaves the area through a symbolic link', async () => {
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    const release = releases(`.tmp-${V}-${OP}`, 'release');
    await fsp.mkdir(release, { recursive: true });
    await fsp.symlink(outside, path.join(release, 'public'));
    const error = thrown(() => stagedReleaseFile(dataDir, V, OP, 'public/a.js'));
    expect(error).toMatchObject({ code: 'INVALID_PATH_SEGMENT', meta: { reason: 'escapes_area' } });
  });
});

// ---- Phase 2 (catalog): Task 3 ----
describe('Phase 2: the exports area, run work files and adoptRunWork (P2-24, S3)', () => {
  const RUN = '01JBX5ZK3M8Q4R7T9V0W2Y6A1E';
  const DRY = '01JBX5ZK3M8Q4R7T9V0W2Y6A1F';

  it('the exports area exists and takes the typed segments only', () => {
    expect(dataPath(dataDir, 'exports')).toBe(path.join(dataDir, 'exports'));
    expect(dataPath(dataDir, 'exports', ULID)).toBe(path.join(dataDir, 'exports', ULID));
    expectInvalid(() => dataPath(dataDir, 'exports', `${ULID}.csv`)); // export files come from exportFilePath only
  });

  it.each(['mrc', 'xml', 'jsonl', 'csv'] as const)('exportFilePath: exports/<ulid>.%s', (ext) => {
    const p = exportFilePath(dataDir, RUN, ext);
    expect(p).toBe(path.join(dataDir, 'exports', `${RUN}.${ext}`));
    expect(p.endsWith(path.join('exports', `${RUN}.${ext}`))).toBe(true);
    expectTypeOf(p).toEqualTypeOf<DataPath>();
  });

  it.each(['pdf', '', 'CSV', 'csv/..', '../csv', 'csv\0', 5 as unknown as string])('exportFilePath refuses the extension %j', (ext) => {
    expectInvalid(() => exportFilePath(dataDir, RUN, ext as 'csv'));
  });

  it.each(['../x', '', '01jbx5zk3m8q4r7t9v0w2y6a1e', 'manifest.json', SHA256])('exportFilePath and the run work builders refuse the run id %j', (id) => {
    expectInvalid(() => exportFilePath(dataDir, id, 'csv'));
    expectInvalid(() => runWorkPath(dataDir, id, 'import.bin'));
    expectInvalid(() => runWorkDir(dataDir, id));
  });

  it.each(['import.bin', 'dump.bin', 'files.bin', 'report.csv', 'biblio.ndjson', 'mst_author.ndjson', `t${'x'.repeat(63)}.ndjson`])(
    'runWorkPath: tmp/<ulid>/%s',
    (name) => {
      const p = runWorkPath(dataDir, RUN, name);
      expect(p).toBe(path.join(dataDir, 'tmp', RUN, name));
      expectTypeOf(p).toEqualTypeOf<DataPath>();
    },
  );

  it.each([
    '../x',
    '..',
    '',
    'upload.bin.ndjson/x',
    'Biblio.ndjson',
    '_biblio.ndjson',
    '1biblio.ndjson',
    'biblio.json',
    '.ndjson',
    `t${'x'.repeat(64)}.ndjson`, // a table name of 65 characters
    'biblio.ndjson\0',
    'a/b.ndjson',
    'report.pdf',
    'manifest.json',
  ])('runWorkPath refuses the name %j', (name) => {
    expectInvalid(() => runWorkPath(dataDir, RUN, name));
  });

  it('runWorkDir: tmp/<ulid>', () => {
    expect(runWorkDir(dataDir, RUN)).toBe(path.join(dataDir, 'tmp', RUN));
  });

  it('adoptRunWork moves tmp/<dry run>/ to tmp/<real run>/, its files with it (S3)', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp', DRY), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', DRY, 'import.bin'), 'isi');
    await fsp.writeFile(path.join(dataDir, 'tmp', DRY, 'biblio.ndjson'), '{}\n');
    await adoptRunWork(dataDir, DRY, RUN);
    expect(await fsp.readFile(runWorkPath(dataDir, RUN, 'import.bin'), 'utf8')).toBe('isi');
    expect(await fsp.readFile(runWorkPath(dataDir, RUN, 'biblio.ndjson'), 'utf8')).toBe('{}\n');
    await expect(fsp.stat(path.join(dataDir, 'tmp', DRY))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adoptRunWork: a missing source folder is NOT_FOUND, and so is a second adoption of the same dry run', async () => {
    await expect(adoptRunWork(dataDir, DRY, RUN)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await fsp.mkdir(path.join(dataDir, 'tmp', DRY), { recursive: true });
    await adoptRunWork(dataDir, DRY, RUN);
    await expect(adoptRunWork(dataDir, DRY, '01JBX5ZK3M8Q4R7T9V0W2Y6A1G')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adoptRunWork refuses a target folder that exists already, and leaves both as they were', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp', DRY), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', DRY, 'dump.bin'), 'a');
    await fsp.mkdir(path.join(dataDir, 'tmp', RUN), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', RUN, 'files.bin'), 'b');
    await expect(adoptRunWork(dataDir, DRY, RUN)).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT', meta: { reason: 'target_exists' } });
    expect(await fsp.readFile(path.join(dataDir, 'tmp', DRY, 'dump.bin'), 'utf8')).toBe('a');
    expect(await fsp.readFile(path.join(dataDir, 'tmp', RUN, 'files.bin'), 'utf8')).toBe('b');
  });

  it('adoptRunWork refuses ids that are not ULIDs, and a run adopting itself', async () => {
    await expect(adoptRunWork(dataDir, '../x', RUN)).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT' });
    await expect(adoptRunWork(dataDir, DRY, '..')).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT' });
    await fsp.mkdir(path.join(dataDir, 'tmp', DRY), { recursive: true });
    await expect(adoptRunWork(dataDir, DRY, DRY)).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT', meta: { reason: 'target_exists' } });
  });
});

// ---- Komunitas K1 (report paths) ----
describe('the report paths: exports/reports/ and tmp/reports/, and the usage import work files', () => {
  const RUN = '01JBX5ZK3M8Q4R7T9V0W2Y6A1H';

  it('the two folders, a run file and a run work folder', () => {
    expect(reportExportsDir(dataDir)).toBe(path.join(dataDir, 'exports', 'reports'));
    expect(reportWorkRoot(dataDir)).toBe(path.join(dataDir, 'tmp', 'reports'));
    expect(reportWorkDir(dataDir, RUN)).toBe(path.join(dataDir, 'tmp', 'reports', RUN));
    expectTypeOf(reportWorkDir(dataDir, RUN)).toEqualTypeOf<DataPath>();
    // dataPath names neither folder: these builders are the only way there.
    expectInvalid(() => dataPath(dataDir, 'exports', 'reports'));
    expectInvalid(() => dataPath(dataDir, 'tmp', 'reports'));
  });

  it.each(['csv', 'xlsx', 'pdf', 'zip'] as const)('reportExportPath: exports/reports/<ulid>.%s', (ext) => {
    const p = reportExportPath(dataDir, RUN, ext);
    expect(p).toBe(path.join(dataDir, 'exports', 'reports', `${RUN}.${ext}`));
    expect(p.endsWith(path.join('exports', 'reports', `${RUN}.${ext}`))).toBe(true);
    expectTypeOf(p).toEqualTypeOf<DataPath>();
  });

  it.each(['mrc', 'jsonl', 'XLSX', '', 'pdf/..', '../zip', 'csv\0', 7 as unknown as string])('reportExportPath refuses the extension %j', (ext) => {
    expectInvalid(() => reportExportPath(dataDir, RUN, ext as 'csv'));
  });

  it.each(['../x', '', '01jbx5zk3m8q4r7t9v0w2y6a1h', 'reports', SHA256])('the report builders refuse the run id %j', (id) => {
    expectInvalid(() => reportExportPath(dataDir, id, 'pdf'));
    expectInvalid(() => reportWorkDir(dataDir, id));
    expectInvalid(() => reportWorkPath(dataDir, id, 'rows.ndjson'));
  });

  it.each([
    'rows.ndjson',
    'output.part',
    'output.central',
    'dossier.pdf',
    'component-K.zip',
    'component-SP.central',
    'component-profil.zip',
    'entry-1.pdf',
    'entry-9999.pdf',
  ])('reportWorkPath: tmp/reports/<ulid>/%s', (name) => {
    const p = reportWorkPath(dataDir, RUN, name);
    expect(p).toBe(path.join(dataDir, 'tmp', 'reports', RUN, name));
    expectTypeOf(p).toEqualTypeOf<DataPath>();
  });

  it.each([
    '../x',
    '..',
    '',
    'rows.json',
    'output.part/..',
    'component-X.zip',
    'component-k.zip',
    'component-K.pdf',
    'entry-0.pdf',
    'entry-01.pdf',
    'entry-10000.pdf',
    'entry-1.zip',
    'dossier.pdf\0',
    'a/rows.ndjson',
  ])('reportWorkPath refuses the name %j', (name) => {
    expectInvalid(() => reportWorkPath(dataDir, RUN, name));
  });

  it.each(['usage-visits-2025-07.bin', 'usage-loans.json', `usage-${'a'.repeat(40)}.json`])('runWorkPath also takes the usage import file %s', (name) => {
    expect(runWorkPath(dataDir, RUN, name)).toBe(path.join(dataDir, 'tmp', RUN, name));
  });

  it.each(['usage-.bin', `usage-${'a'.repeat(41)}.json`, 'usage-Visits.bin', 'usage-x.ndjson', 'usage-x_y.bin', 'usage-x.bin/..'])(
    'runWorkPath refuses the usage name %j',
    (name) => {
      expectInvalid(() => runWorkPath(dataDir, RUN, name));
    },
  );
});
