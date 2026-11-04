import { createLog } from './log.js';
import { isSupportedNode, nodeVersion } from './node-version.js';
import { earlyPort, exitWith, printJsonFailure, rescueDetail, rescueSteps, rescueSummary, serveRescue, wantsJson } from './rescue.js';

// app.js, the bootloader (spec §9.2, contract v1): what cPanel/Passenger, LiteSpeed, PM2, Docker, the Windows
// service and `node app.js` run. Built by build.ts into one CommonJS file with ES2017 syntax (P1).
//
// Step 1 is the Node version check, and it comes first (ruling R56): hosting panels still offer Node 10 to 20.
// Until it has passed, only this file, node-version.ts, rescue.ts and log.ts have run, and they use nothing that
// Node 10 lacks (the only module required is `http`). Everything else (@altis/platform, @altis/crypto, the release
// checks, the supervisor) sits in boot.ts, which esbuild wraps so that it is evaluated only when the dynamic import
// below runs.

/** Usage as a command (`node app.js doctor`): app.js is the main module and has arguments. Under Passenger app.js is
 * loaded by Passenger's own loader, so its process.argv is never taken for a command. */
function commandLine(): string[] | null {
  const argv = process.argv.slice(2);
  return argv.length > 0 && require.main === module ? argv : null;
}

function invalidEarlyPortMessage(): string {
  return (
    'ALTIS: ALTIS_PORT atau PORT bukan nomor port yang sah (1-65535).\n' +
    'ALTIS: ALTIS_PORT or PORT is not a valid port number (1-65535).\n'
  );
}

function main(): void {
  // A stderr whose reader went away must not crash the process (the log only writes to it).
  process.stderr.on('error', () => {});
  const log = createLog();
  const argv = commandLine();
  const version = nodeVersion(process.env);

  if (!isSupportedNode(version)) {
    const message =
      rescueSummary('NODE_TOO_OLD') + 'ALTIS: Node ' + version + ' terpasang / is running.\n' + rescueSteps('NODE_TOO_OLD');
    if (argv !== null) {
      if (wantsJson(argv)) printJsonFailure(argv, 'NODE_TOO_OLD', rescueDetail('NODE_TOO_OLD'));
      exitWith(1, message);
      return;
    }
    const port = earlyPort(process.env);
    if (port === null) {
      exitWith(1, message + invalidEarlyPortMessage());
      return;
    }
    process.stderr.write(message);
    serveRescue('NODE_TOO_OLD', port, log);
    return;
  }

  import('./boot.js').then(
    (loaded) =>
      loaded.boot({ appRoot: __dirname, script: __filename, argv: argv === null ? [] : argv, cli: argv !== null, log }),
    (error: unknown) => {
      log.error('app.js could not load its own code', { err: error });
      const damaged = 'app.js rusak; unggah ulang paket zip / app.js is damaged; upload the zip package again.';
      if (argv !== null && wantsJson(argv)) printJsonFailure(argv, 'START_FAILED', damaged);
      exitWith(1, 'ALTIS: ' + damaged + '\n');
    },
  );
}

main();
