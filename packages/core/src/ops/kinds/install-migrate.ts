import type { OpKindHandler } from '../machine.js';
import { migrationStep, type MigrationKindDeps } from './migrate.js';

// The `install-migrate` op kind (spec §9.5, Task 27): the web wizard's `POST install/api/migrate` calls `step(1)`, and
// each call applies exactly one migration (§9.5 "satu migrateUp() per panggilan, ≤ 20 detik"), on `ctx.db()`, which
// the server points at the wizard's handle before the install completes (S11). The maintenance reason `install` lets
// the wizard's routes through the gate while the op runs (spec §9.4).

/** The `install-migrate` kind: the step of `migrate` (one migration per handler step) under maintenance `install`. */
export function installMigrateKind(deps: MigrationKindDeps): OpKindHandler {
  return {
    kind: 'install-migrate',
    initialState: 'running',
    maintenance: 'install',
    freeze: false,
    step: (ctx, op) => migrationStep(deps, ctx, op),
  };
}
