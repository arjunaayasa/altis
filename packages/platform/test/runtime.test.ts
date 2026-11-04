import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIMES, detectRuntime, isEnvSet, pm2ClusterSignals, sqliteAllowed, type Runtime } from '../src/runtime.js';

type Env = Record<string, string | undefined>;
type Globals = { PhusionPassenger?: unknown };

describe('detectRuntime', () => {
  const cases: Array<[string, Env, Globals, Runtime]> = [
    // 1. ALTIS_RUNTIME wins when it names one of the six runtimes
    ['ALTIS_RUNTIME=passenger', { ALTIS_RUNTIME: 'passenger' }, {}, 'passenger'],
    ['ALTIS_RUNTIME=litespeed', { ALTIS_RUNTIME: 'litespeed' }, {}, 'litespeed'],
    ['ALTIS_RUNTIME=pm2', { ALTIS_RUNTIME: 'pm2' }, {}, 'pm2'],
    ['ALTIS_RUNTIME=docker', { ALTIS_RUNTIME: 'docker' }, {}, 'docker'],
    ['ALTIS_RUNTIME=service', { ALTIS_RUNTIME: 'service' }, {}, 'service'],
    ['ALTIS_RUNTIME=standalone', { ALTIS_RUNTIME: 'standalone' }, {}, 'standalone'],
    ['ALTIS_RUNTIME beats the passenger global', { ALTIS_RUNTIME: 'docker' }, { PhusionPassenger: {} }, 'docker'],
    ['ALTIS_RUNTIME beats IN_PASSENGER', { ALTIS_RUNTIME: 'service', IN_PASSENGER: '1' }, {}, 'service'],
    ['ALTIS_RUNTIME beats LSNODE_', { ALTIS_RUNTIME: 'standalone', LSNODE_ROOT: '/x' }, {}, 'standalone'],
    ['ALTIS_RUNTIME beats pm_id', { ALTIS_RUNTIME: 'docker', pm_id: '0' }, {}, 'docker'],

    // 1b. an ALTIS_RUNTIME outside the six is ignored and detection continues
    ['unknown ALTIS_RUNTIME falls through to standalone', { ALTIS_RUNTIME: 'kubernetes' }, {}, 'standalone'],
    ['unknown ALTIS_RUNTIME falls through to pm2', { ALTIS_RUNTIME: 'nope', pm_id: '3' }, {}, 'pm2'],
    ['ALTIS_RUNTIME is case-sensitive', { ALTIS_RUNTIME: 'Docker' }, {}, 'standalone'],
    ['empty ALTIS_RUNTIME is ignored', { ALTIS_RUNTIME: '' }, {}, 'standalone'],
    ['inherited names are not runtimes', { ALTIS_RUNTIME: 'constructor' }, {}, 'standalone'],

    // 2. Passenger
    ['PhusionPassenger global', {}, { PhusionPassenger: {} }, 'passenger'],
    ['PhusionPassenger global, any non-undefined value', {}, { PhusionPassenger: true }, 'passenger'],
    ['IN_PASSENGER=1', { IN_PASSENGER: '1' }, {}, 'passenger'],
    ['PASSENGER_APP_ENV set', { PASSENGER_APP_ENV: 'production' }, {}, 'passenger'],
    ['IN_PASSENGER other than 1 is not a marker', { IN_PASSENGER: '0' }, {}, 'standalone'],
    ['empty PASSENGER_APP_ENV is not a marker', { PASSENGER_APP_ENV: '' }, {}, 'standalone'],
    ['blank PASSENGER_APP_ENV is not a marker', { PASSENGER_APP_ENV: ' \t' }, {}, 'standalone'],
    ['undefined PhusionPassenger is not a marker', {}, { PhusionPassenger: undefined }, 'standalone'],
    ['passenger beats litespeed', { IN_PASSENGER: '1', LSNODE_ROOT: '/x' }, {}, 'passenger'],
    ['passenger beats pm2', { PASSENGER_APP_ENV: 'production', pm_id: '0' }, {}, 'passenger'],

    // 3. LiteSpeed
    ['LSNODE_ prefixed key', { LSNODE_ROOT: '/home/x' }, {}, 'litespeed'],
    ['LSNODE_ key among others', { PATH: '/bin', LSNODE_FOO: '1', HOME: '/h' }, {}, 'litespeed'],
    ['litespeed beats pm2', { LSNODE_ROOT: '/x', pm_id: '0' }, {}, 'litespeed'],
    ['LSNODE_ key with an undefined value is not a marker', { LSNODE_ROOT: undefined }, {}, 'standalone'],
    ['LSNODE_ key with an empty value is not a marker', { LSNODE_ROOT: '' }, {}, 'standalone'],
    ['LSNODE_ key with a blank value is not a marker', { LSNODE_ROOT: '  ' }, {}, 'standalone'],
    ['a set LSNODE_ key wins over unset ones', { LSNODE_A: '', LSNODE_B: '/x' }, {}, 'litespeed'],
    ['LSNODE without the underscore is not a marker', { LSNODE: '1' }, {}, 'standalone'],
    ['the prefix must be at the start of the key', { X_LSNODE_ROOT: '1' }, {}, 'standalone'],
    ['the prefix is case-sensitive', { lsnode_root: '1' }, {}, 'standalone'],

    // 4. PM2
    ['pm_id=0', { pm_id: '0' }, {}, 'pm2'],
    ['pm_id=7', { pm_id: '7' }, {}, 'pm2'],
    ['empty pm_id is not a marker', { pm_id: '' }, {}, 'standalone'],
    ['blank pm_id is not a marker', { pm_id: ' ' }, {}, 'standalone'],

    // 5. default; docker and service are reachable only through ALTIS_RUNTIME
    ['empty environment', {}, {}, 'standalone'],
    ['unrelated environment', { PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'production' }, {}, 'standalone'],
    ['a docker-looking environment without ALTIS_RUNTIME', { container: 'docker', HOSTNAME: 'abc123' }, {}, 'standalone'],
  ];

  it.each(cases)('%s', (_label, env, g, expected) => {
    expect(detectRuntime(env, g)).toBe(expected);
  });

  describe('reads only its arguments', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('ignores process.env when given another environment', () => {
      vi.stubEnv('pm_id', '1');
      vi.stubEnv('LSNODE_ROOT', '/x');
      vi.stubEnv('ALTIS_RUNTIME', 'docker');
      expect(detectRuntime({}, {})).toBe('standalone');
    });

    it('accepts process.env itself', () => {
      vi.stubEnv('ALTIS_RUNTIME', '');
      vi.stubEnv('IN_PASSENGER', '');
      vi.stubEnv('PASSENGER_APP_ENV', '');
      for (const name of Object.keys(process.env)) if (name.startsWith('LSNODE_')) vi.stubEnv(name, '');
      vi.stubEnv('pm_id', '4');
      expect(detectRuntime(process.env, {})).toBe('pm2');
    });

    it('does not modify the environment it is given', () => {
      const env = Object.freeze({ pm_id: '0', LSNODE_ROOT: '/x' });
      expect(detectRuntime(env, {})).toBe('litespeed');
      expect(env).toEqual({ pm_id: '0', LSNODE_ROOT: '/x' });
    });
  });
});

describe('isEnvSet', () => {
  it.each<[string, Record<string, string | undefined>, boolean]>([
    ['a value', { X: 'a' }, true],
    ['zero', { X: '0' }, true],
    ['a value with surrounding blanks', { X: ' a ' }, true],
    ['an empty string', { X: '' }, false],
    ['spaces only', { X: '   ' }, false],
    ['tabs and newlines only', { X: '\t\r\n' }, false],
    ['undefined', { X: undefined }, false],
    ['a missing key', {}, false],
  ])('%s', (_label, env, expected) => {
    expect(isEnvSet(env, 'X')).toBe(expected);
  });

  it('does not see inherited properties', () => {
    expect(isEnvSet({}, 'constructor')).toBe(false);
    expect(isEnvSet({}, 'toString')).toBe(false);
  });
});

describe('RUNTIMES', () => {
  it('lists the six runtimes', () => {
    expect([...RUNTIMES].sort()).toEqual(['docker', 'litespeed', 'passenger', 'pm2', 'service', 'standalone']);
  });
});

describe('sqliteAllowed', () => {
  it.each<[Runtime, boolean]>([
    ['passenger', false],
    ['litespeed', false],
    ['pm2', true],
    ['docker', true],
    ['service', true],
    ['standalone', true],
  ])('%s -> %s', (runtime, expected) => {
    expect(sqliteAllowed(runtime)).toBe(expected);
  });
});

// 1d Task 32 (L8, decision D1d-36): what PM2 puts in the environment of a process it runs in cluster mode or as one of
// several instances. SQLite needs one process per file (P20), so under runtime pm2 any signal refuses it.
describe('pm2ClusterSignals', () => {
  it("the brief's cases: cluster mode, instance 0 and instance 1", () => {
    expect(pm2ClusterSignals({ exec_mode: 'cluster_mode' })).toEqual(['exec_mode=cluster_mode']);
    expect(pm2ClusterSignals({ NODE_APP_INSTANCE: '0' })).toEqual([]);
    expect(pm2ClusterSignals({ NODE_APP_INSTANCE: '1' })).toEqual(['NODE_APP_INSTANCE=1']);
  });

  it('none outside PM2, and none for the shipped template (fork mode, one instance)', () => {
    expect(pm2ClusterSignals({})).toEqual([]);
    expect(pm2ClusterSignals({ pm_id: '0', exec_mode: 'fork_mode', instances: '1', NODE_APP_INSTANCE: '0' })).toEqual([]);
  });

  it('NODE_APP_INSTANCE unset, empty or blank, or 0, is no signal', () => {
    for (const value of [undefined, '', '  ', '0', ' 0 ']) {
      expect(pm2ClusterSignals({ NODE_APP_INSTANCE: value }), String(value)).toEqual([]);
    }
  });

  it('instances above 1 (or max) is a signal; 1 or nothing is none', () => {
    expect(pm2ClusterSignals({ instances: '2' })).toEqual(['instances=2']);
    expect(pm2ClusterSignals({ instances: '16' })).toEqual(['instances=16']);
    expect(pm2ClusterSignals({ instances: 'max' })).toEqual(['instances=max']);
    expect(pm2ClusterSignals({ instances: '1' })).toEqual([]);
    expect(pm2ClusterSignals({ instances: '' })).toEqual([]);
  });

  it('every signal at once, in a fixed order (exec_mode, instances, NODE_APP_INSTANCE)', () => {
    expect(pm2ClusterSignals({ NODE_APP_INSTANCE: '3', instances: '4', exec_mode: 'cluster_mode' })).toEqual([
      'exec_mode=cluster_mode',
      'instances=4',
      'NODE_APP_INSTANCE=3',
    ]);
  });

  it('fork mode with two instances: both processes see instances=2, the first one (NODE_APP_INSTANCE 0) too', () => {
    expect(pm2ClusterSignals({ exec_mode: 'fork_mode', instances: '2', NODE_APP_INSTANCE: '0' })).toEqual(['instances=2']);
    expect(pm2ClusterSignals({ exec_mode: 'fork_mode', instances: '2', NODE_APP_INSTANCE: '1' })).toEqual([
      'instances=2',
      'NODE_APP_INSTANCE=1',
    ]);
  });

  it('names a signal without echoing an unexpected value (signals reach logs and doctor output)', () => {
    expect(pm2ClusterSignals({ NODE_APP_INSTANCE: 'web-2 <x>' })).toEqual(['NODE_APP_INSTANCE=?']);
    expect(pm2ClusterSignals({ instances: '99999999999999999999' })).toEqual(['instances=?']);
    expect(pm2ClusterSignals({ exec_mode: 'cluster' })).toEqual(['exec_mode=cluster']);
    expect(pm2ClusterSignals({ exec_mode: 'something_else', instances: 'two' })).toEqual([]);
  });
});
