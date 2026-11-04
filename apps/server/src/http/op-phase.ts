import type { AppPhase } from '../app.js';

// The phases in which the app waits on an op and serves only that op's pages (a module of its own: app.ts imports the
// route modules, which import ops-auth.ts, so ops-auth.ts may not import a value from app.ts).

/**
 * Whether the app waits on an op in `phase` and serves only the op's own pages: `ops_wait` (1c Task 15), and 1d Task
 * 25's `updating` (start() boots an update's target, or steps its revert, inside the update op). In `ops_wait` no session
 * is read (the ops routes open by `altis_ops` alone); in `updating` one is while no op moves the schema, and the sign-in
 * passes then too (1d review C16, http/ops-auth.ts opsSessionAllowed). Every other route answers 503 MAINTENANCE.
 */
export function servesOpOnly(phase: AppPhase): boolean {
  return phase === 'ops_wait' || phase === 'updating';
}
