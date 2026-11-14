// Child process for accred-freeze-race.test.ts, started through `node --import tsx` (two processes, two connections,
// SQLite included).
//
// Usage: accred-freeze-child.mjs <optionsJson>, options {config, dataDir, periodId, code, actorId, frozenStop}. Opens the
// test database (dataDir holds the SQLite file), sends 'ready' over IPC and waits for 'go'. Then it writes the answer of
// indicator `code` again and again, each write in a transaction of its own as the answer route does, with a sequence
// number: write n answers 'abcd'[(n - 1) % 4], by hand for the first four writes of every eight and as an override for
// the next four, with the note `urutan <n>`. After each write it sends {seq, ok: true} when it committed or
// {seq, frozen: true} when the period was frozen. It stops after `frozenStop` frozen writes and exits 0; any other
// error is sent as {seq, error: code} and it exits 1. It exits 2 when its parent's IPC channel closes, so it never
// outlives its test.
import { connect, withTx } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { putAnswer } from '../../src/accreditation/periods/answers.ts';
import { txCtx } from '../../src/context.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const send = (message) => new Promise((resolve) => process.send(message, () => resolve()));

async function run(h) {
  let frozen = 0;
  for (let seq = 1; frozen < o.frozenStop; seq += 1) {
    const answer = 'abcd'[(seq - 1) % 4];
    const mode = Math.floor((seq - 1) / 4) % 2 === 0 ? 'manual' : 'override';
    const now = Date.now();
    try {
      await withTx(h, (trx) => putAnswer(txCtx(trx, now, { type: 'staff', id: o.actorId, ip: null }), o.periodId, o.code, { answer, mode, note: `urutan ${seq}` }, now));
      await send({ seq, ok: true });
    } catch (error) {
      if (isDomainError(error) && error.code === 'ACCRED_PERIOD_FROZEN') {
        frozen += 1;
        await send({ seq, frozen: true });
        continue;
      }
      if (!isDomainError(error)) console.error(error);
      await send({ seq, error: isDomainError(error) ? error.code : String(error?.name) });
      return 1;
    }
  }
  return 0;
}

const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });
process.on('message', (message) => {
  if (message !== 'go') return;
  run(h).then(async (code) => {
    await h.close();
    process.exit(code);
  });
});
process.send('ready');
