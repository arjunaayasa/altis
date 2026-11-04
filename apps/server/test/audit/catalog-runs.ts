import fsp from 'node:fs/promises';
import path from 'node:path';
import { exportFilePath } from '@altis/platform';
import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `runs` (Phase 2 plan, Task 2 scaffold; filled by Task 19, Runs and the
// dedupe scan): `GET catalog/runs/:id/download` audits the download of an export. The export job is Task 31's, so the
// script leaves a finished `csv-records` export as that job does (its run row and `exports/<runId>.csv`), then a super
// admin downloads it whole and a part of it, through the API as the admin SPA does: one entry per download, with the
// format and the bytes served.

const DAY = 86_400_000;
const CONTENT = 'judul,tahun\r\nBumi Manusia,1980\r\n';

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.export.download'],
  run: async (s) => {
    const now = s.clock.now;
    const id = newId(now);
    await s.db.db
      .insertInto('catalog_runs')
      .values({
        id,
        kind: 'export',
        status: 'succeeded',
        dry_run: 0,
        format: 'csv-records',
        options: '{}',
        summary: '{}',
        report_file_id: null,
        output_name: `${id}.csv`,
        output_size: Buffer.byteLength(CONTENT),
        expires_at: now + 7 * DAY,
        job_id: null,
        created_at: now,
        created_by: s.admin.userId,
        finished_at: now,
      })
      .execute();
    const file = exportFilePath(s.dataDir, id, 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, CONTENT);

    const whole = await s.admin.send('get', `/api/v1/catalog/runs/${id}/download`);
    expect(whole.status, whole.text).toBe(200);
    expect(whole.text).toBe(CONTENT);
    const part = await s.admin.send('get', `/api/v1/catalog/runs/${id}/download`, undefined, { range: 'bytes=0-4' });
    expect([part.status, part.text]).toEqual([206, 'judul']);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['actor_id', 'entity', 'meta'])
      .where('action', '=', 'catalog.export.download')
      .where('entity_id', '=', id)
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => ({ actor: e.actor_id, entity: e.entity, meta: JSON.parse(e.meta ?? 'null') as unknown }))).toEqual([
      { actor: s.admin.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: Buffer.byteLength(CONTENT) } },
      { actor: s.admin.userId, entity: 'catalog_runs', meta: { format: 'csv-records', bytes: 5 } },
    ]);
  },
};
