import fs from 'node:fs';
import path from 'node:path';
import { personalLogKeys } from '@altis/db';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { useDataDir } from './support.js';

// The server log never writes a registered personal value: a field whose key, lower-cased and without underscores, is
// the name of a registered personal column or JSON path is redacted at any depth, as a secret-like key is. A field that
// is not personal is kept (`count`), and so is the class name of an error.

const dirs = useDataDir();

function lines(): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(dirs.dataDir, 'logs', 'altis.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the logger and the personal columns', () => {
  it('redacts the personal keys of a line and keeps the others', () => {
    const log = createLogger({ dataDir: dirs.dataDir, level: 'debug' });
    log.info('register row saved', { name: 'Siti', appointmentRef: 'SK-9', schoolHead: 'Budi', count: 3 });
    const [line] = lines();
    expect(line).toMatchObject({ msg: 'register row saved', name: '[redacted]', appointmentRef: '[redacted]', schoolHead: '[redacted]', count: 3 });
    expect(JSON.stringify(line)).not.toMatch(/Siti|SK-9|Budi/);
  });

  it('matches a key whatever its case and underscores, at any depth, in a child logger too', () => {
    const log = createLogger({ dataDir: dirs.dataDir, level: 'debug' }).child({ library_head: 'Ani' });
    log.warn('profile read', { row: { appointment_ref: 'SK-1', Address: 'Jl. Mawar 3', LibraryHeadId: '1975', periodId: 'p1' }, items: [{ note: 'catatan' }] });
    const [line] = lines();
    expect(line).toMatchObject({
      library_head: '[redacted]',
      row: { appointment_ref: '[redacted]', Address: '[redacted]', LibraryHeadId: '[redacted]', periodId: 'p1' },
      items: [{ note: '[redacted]' }],
    });
    expect(JSON.stringify(line)).not.toMatch(/Ani|SK-1|Mawar|1975|catatan/);
  });

  it('keeps the class name of an error, and the registered keys are the ones the database registry names', () => {
    const log = createLogger({ dataDir: dirs.dataDir, level: 'debug' });
    log.error('failed', { error: new RangeError('r') });
    expect(lines()[0]!['error']).toMatchObject({ name: 'RangeError', message: 'r' });
    expect([...personalLogKeys()]).toEqual(expect.arrayContaining(['name', 'appointmentref', 'schoolhead', 'note', 'profile', 'address']));
  });
});
