// Child process for config.test.ts, started through `node --import tsx`.
//
// Usage: config-child.mjs <dataDir> <id> <count>
// Sends 'ready' over IPC, waits for 'go', then calls updateConfig <count> times, each time adding the origin
// `https://<id>-<n>.example` to allowedOrigins (an update that depends on what the file holds right then, so
// a lost update shows as a missing origin). The environment carries ALTIS_DB_PASSWORD, which must never reach the file.
import { updateConfig } from '../../src/config.ts';

const [dataDir, id, countText] = process.argv.slice(2);
const count = Number(countText);

async function run() {
  for (let n = 0; n < count; n += 1) {
    await updateConfig(dataDir, (config) => {
      config.allowedOrigins.push(`https://${id}-${n}.example`);
    });
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
