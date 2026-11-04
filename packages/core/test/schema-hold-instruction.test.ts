import { describe, expect, it } from 'vitest';
import { schemaHoldInstruction } from '../src/updates/bundled.js';

// The instruction of a failed `schemaHold` (spec §9.8 row 3 "jalankan lagi image/zip versi sebelumnya, lalu pulihkan
// backup pre_update"; decision D1d-24; plan Task 27). 1d Task 35's docker-pull smoke follows it as an operator would:
// the commands it names must work in that order. `node app.js backup:restore` refuses while the maintenance flag that the
// failure keeps is up (cli/backup.ts: "Refused under maintenance"), so the flag is switched off first, as
// /admin/_update's CLI lines say for a `restore_failed` op (ops/update-script.ts cliLines).

describe('schemaHoldInstruction', () => {
  it('with a pre_update backup: the previous image or zip again, maintenance off, then backup:restore <id>, in both languages', () => {
    const text = schemaHoldInstruction({ version: '0.3.0-test', from: '0.2.0-test', backupId: '01ABCDEF' });
    const [id, en] = text.split(' / The ');
    for (const part of [id!, en!]) {
      expect(part).toContain('0.2.0-test');
      const off = part.indexOf('node app.js maintenance:off');
      const restore = part.indexOf('node app.js backup:restore 01ABCDEF');
      expect(off, part).toBeGreaterThan(-1);
      expect(restore, part).toBeGreaterThan(off);
    }
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('without a backup (failed before the database changed): the previous image or zip again, then maintenance off', () => {
    const text = schemaHoldInstruction({ version: '0.3.0-test', from: null, backupId: null });
    expect(text).toContain('node app.js maintenance:off');
    expect(text).not.toContain('backup:restore');
  });
});
