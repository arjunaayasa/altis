// Child process for rotating-file.test.ts, started through `node --import tsx`.
//
// Usage: rotating-file-child.mjs <logPath> <id> <count> <maxBytes> <files>
// Sends 'ready' over IPC, waits for 'go' (so that the children start together), then appends <count> lines
// `{"id":<id>,"n":<n>,"pad":"xxx..."}` to <logPath> through createRotatingFile, yielding to the event loop
// between lines so that the processes really interleave. A rotation failure is reported on stderr.
import nodePath from 'node:path';
import { createRotatingFile } from '../../src/rotating-file.ts';

const [logPath, id, countText, maxBytesText, filesText] = process.argv.slice(2);
const count = Number(countText);
const pad = 'x'.repeat(60);

// Warm up every code path (claim, rotation, lazy module loads) on a file of its own, so that the first real
// rotation is not slow enough for the other processes to write their whole share meanwhile.
const warm = createRotatingFile(nodePath.join(nodePath.dirname(logPath), '..', `warmup-${id}`, 'warm.log'), {
  maxBytes: 10,
  files: 2,
});
for (let n = 0; n < 4; n += 1) warm.append(`warm-up ${n}\n`);
warm.close();

const file = createRotatingFile(logPath, {
  maxBytes: Number(maxBytesText),
  files: Number(filesText),
  onError: (error) => console.error('rotation error', error),
});

async function run() {
  for (let n = 0; n < count; n += 1) {
    file.append(`${JSON.stringify({ id, n, pad })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  file.close();
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
