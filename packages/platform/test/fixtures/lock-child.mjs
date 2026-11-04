// Child process for lock.test.ts, started through `node --import tsx`.
//
// Usage: lock-child.mjs <lockPath> <dataFile> <id> <count|hold>
// Sends 'ready' over IPC, waits for 'go' (so that both children start together), then appends <count>
// lines `<id>:<n>:<payload>` to <dataFile>, each inside withFileLock. Every line is written in three
// separate writes with a pause in between, so two children that were not mutually exclusive would
// interleave their lines.
// With `hold` instead of a count it takes the lock, sends 'held' and keeps the lock until it is killed.
import fsp from 'node:fs/promises';
import { withFileLock } from '../../src/lock.ts';

const [lockPath, dataFile, id, countText] = process.argv.slice(2);
const hold = countText === 'hold';
const count = hold ? 0 : Number(countText);
const payload = 'x'.repeat(120);
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));

async function appendLine(n) {
  const handle = await fsp.open(dataFile, 'a');
  try {
    await handle.write(`${id}:${n}:`);
    await pause();
    await handle.write(payload);
    await pause();
    await handle.write('\n');
  } finally {
    await handle.close();
  }
}

async function run() {
  if (hold) {
    await withFileLock(lockPath, async () => {
      process.send('held');
      await new Promise(() => {});
    });
  }
  for (let n = 0; n < count; n += 1) {
    await withFileLock(lockPath, () => appendLine(n), { waitMs: 20_000 });
  }
}

process.on('message', (message) => {
  if (message !== 'go') return;
  run().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
});
process.send('ready');
