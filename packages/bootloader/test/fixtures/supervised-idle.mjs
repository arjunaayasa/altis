// A supervised child with nothing left to do (supervisor.test.ts), started with `fork(…, {execArgv: ['--import',
// 'tsx']})`: it registers the "exit when the supervisor is gone" rule and then has no work. A graceful shutdown ends
// like this (server closed, timers cleared): the process must exit by itself, not be held by the IPC channel.
import { exitWithSupervisor } from '../../src/supervisor.ts';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
exitWithSupervisor(silent);
process.send({ ready: true });
