import { expect } from 'vitest';
import { reportExportPath } from '@altis/platform';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the report runs: `POST reports/runs` audits the start of a run (`reports.run.start {runId,
// reportId, format}`, never a parameter value) and `GET reports/runs/:id/download` each download of its file
// (`reports.run.download`, same meta). The export job's real work is not needed here: the script starts a run of the
// test profile's `test.rows` through the API as the admin SPA does, then leaves the run as the job does (succeeded, its
// file in place) and downloads it whole and a part of it. Each route call writes exactly one entry.

const DAY = 86_400_000;
const CONTENT = 'n,text,amount\r\n1,baris 1,1500\r\n2,baris 2,3000\r\n';

export const AUDIT: AreaAuditScript = {
  actions: ['reports.run.start', 'reports.run.download'],
  run: async (s) => {
    const now = s.clock.now;
    const start = await s.admin.send('post', '/api/v1/reports/runs', { reportId: 'test.rows', format: 'csv', params: { rows: 2 } });
    expect(start.status, start.text).toBe(200);
    const id = (start.json as { id: string }).id;

    await s.db.db
      .updateTable('report_runs')
      .set({ status: 'succeeded', row_count: 2, output_name: `${id}.csv`, output_size: Buffer.byteLength(CONTENT), expires_at: now + 7 * DAY, finished_at: now })
      .where('id', '=', id)
      .execute();
    const file = reportExportPath(s.dataDir, id, 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, CONTENT);

    const whole = await s.admin.send('get', `/api/v1/reports/runs/${id}/download`);
    expect([whole.status, whole.text]).toEqual([200, CONTENT]);
    const part = await s.admin.send('get', `/api/v1/reports/runs/${id}/download`, undefined, { range: 'bytes=0-4' });
    expect([part.status, part.text]).toEqual([206, CONTENT.slice(0, 5)]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'entity', 'meta'])
      .where('action', 'in', ['reports.run.start', 'reports.run.download'])
      .where('entity_id', '=', id)
      .orderBy('seq')
      .execute();
    const meta = { runId: id, reportId: 'test.rows', format: 'csv' };
    expect(entries.map((e) => ({ action: e.action, actor: e.actor_id, entity: e.entity, meta: JSON.parse(e.meta ?? 'null') as unknown }))).toEqual([
      { action: 'reports.run.start', actor: s.admin.userId, entity: 'report_runs', meta },
      { action: 'reports.run.download', actor: s.admin.userId, entity: 'report_runs', meta },
      { action: 'reports.run.download', actor: s.admin.userId, entity: 'report_runs', meta },
    ]);
  },
};
