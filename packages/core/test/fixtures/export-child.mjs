// Child process for backup-export.test.ts, started through `node --import tsx`: runs a backup export in steps, as a
// job runner would, and keeps the checkpoint in a JSON file between steps, so that a process killed in the middle
// of a part (ALTIS_TEST_FAULT=export-mid-part:<n>) can be followed by another one that resumes from it (P7).
//
// Usage: export-child.mjs <optionsJson>, options {config, dbDataDir, dataDir, backupId, checkpointFile, stepMs,
// sessionKey (base64url), schemaVersion, installId, includeFiles, auditHead}. Each step gets a deadline `stepMs` away; after each
// step the checkpoint is written to `checkpointFile` (a temporary file renamed over it). It exits 0 once the export is
// done, 1 on any error, and 2 when its parent's IPC channel closes, so it never outlives its test.
import fsp from 'node:fs/promises';
import { decodeBase64Url } from '@altis/crypto';
import { connect } from '@altis/db';
import { createExporter } from '../../src/backup/exporter.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

async function readCheckpoint() {
  try {
    return JSON.parse(await fsp.readFile(o.checkpointFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeCheckpoint(checkpoint) {
  const temp = `${o.checkpointFile}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(checkpoint));
  await fsp.rename(temp, o.checkpointFile);
}

const h = await connect(o.config, { runtime: 'standalone', purpose: 'cli', dataDir: o.dbDataDir });
const exporter = createExporter({
  read: h.db,
  dialect: h.dialect,
  dataDir: o.dataDir,
  backupId: o.backupId,
  kind: 'manual',
  includeFiles: o.includeFiles,
  consistency: 'frozen',
  appVersion: '0.1.0',
  schemaVersion: o.schemaVersion,
  installId: o.installId,
  sessionKey: decodeBase64Url(o.sessionKey),
  kids: ['k1'],
  auditHead: o.auditHead,
  clock: () => Date.now(),
});

async function run() {
  let checkpoint = await readCheckpoint();
  for (;;) {
    const result = await exporter.step(checkpoint, { deadline: Date.now() + o.stepMs });
    checkpoint = result.checkpoint;
    await writeCheckpoint(checkpoint);
    if (result.done) return;
  }
}

run()
  .finally(() => h.close())
  .then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
