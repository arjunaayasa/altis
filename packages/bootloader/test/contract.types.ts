// Bootloader contract v1 (spec §9.2) is written down twice: app.js's side in src/boot-core.ts (BootContext, exported
// from src/boot.ts), src/front.ts (RequestHandler) and src/release.ts (ServerModule), server.mjs's side in
// apps/server/src/index.ts. Once the first
// public release has shipped app.js the contract is frozen, and a copy that drifted would still compile on both sides
// and fail only at run time, on real installs (1c/1d will touch markHealthy, bootMarker and serve).
//
// This file is not a test that runs: `pnpm check` (tsc -b) compiles it, and it does not compile unless the two copies
// agree. Each type must be assignable to the other in both directions, name the same members, and take the same
// parameters in its methods (method parameters are compared bivariantly by assignability alone).

import type * as Server from '../../../apps/server/src/index.js';
import type { BootContext as LoaderContext } from '../src/boot.js';
import type { RequestHandler as LoaderHandler } from '../src/front.js';
import type { ServerModule } from '../src/release.js';

type ServerContext = Server.BootContext;
type ServerHandler = Server.RequestHandler;

/** `true` only when A and B are assignable to each other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** `true` only when A and B name exactly the same members. */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : false;
/** `true` only when the parameter lists of two functions are assignable to each other. */
type SameParameters<F, G> = F extends (...args: infer P) => unknown ? (G extends (...args: infer Q) => unknown ? Mutual<P, Q> : false) : false;

// app.js hands its BootContext to start(ctx) and runCli(argv, ctx), which declare the server's.
export const contextIsMutual: Mutual<LoaderContext, ServerContext> = true;
export const contextHasTheSameMembers: SameKeys<LoaderContext, ServerContext> = true;
export const releaseHasTheSameMembers: SameKeys<LoaderContext['release'], ServerContext['release']> = true;
export const bootMarkerHasTheSameMembers: SameKeys<LoaderContext['bootMarker'], ServerContext['bootMarker']> = true;
export const logHasTheSameMembers: SameKeys<LoaderContext['log'], ServerContext['log']> = true;
export const phaseTakesTheSamePhases: SameParameters<LoaderContext['bootMarker']['phase'], ServerContext['bootMarker']['phase']> = true;
export const markHealthyTakesTheSame: SameParameters<LoaderContext['markHealthy'], ServerContext['markHealthy']> = true;
export const requestRestartTakesTheSame: SameParameters<LoaderContext['requestRestart'], ServerContext['requestRestart']> = true;
export const serveTakesTheSame: SameParameters<LoaderContext['serve'], ServerContext['serve']> = true;
// 1c Task 23 (decision C29): the optional app.js version, the same type on both sides.
export const appJsVersionIsTheSame: Mutual<LoaderContext['appJsVersion'], ServerContext['appJsVersion']> = true;
export const logInfoTakesTheSame: SameParameters<LoaderContext['log']['info'], ServerContext['log']['info']> = true;
// 1d Task 16 (additive in v1): the boot marker's wait, the bundled release, the boot mode, the pending boot.
export const waitingTakesTheSame: SameParameters<
  NonNullable<LoaderContext['bootMarker']['waiting']>,
  NonNullable<ServerContext['bootMarker']['waiting']>
> = true;
export const waitingIsOptionalOnBothSides: Mutual<LoaderContext['bootMarker']['waiting'], ServerContext['bootMarker']['waiting']> = true;
export const bundledReleaseIsTheSame: Mutual<LoaderContext['bundledRelease'], ServerContext['bundledRelease']> = true;
export const bundledReleaseHasTheSameMembers: SameKeys<NonNullable<LoaderContext['bundledRelease']>, NonNullable<ServerContext['bundledRelease']>> = true;
export const bootModeIsTheSame: Mutual<LoaderContext['bootMode'], ServerContext['bootMode']> = true;
export const pendingBootIsTheSame: Mutual<LoaderContext['pendingBoot'], ServerContext['pendingBoot']> = true;
export const logChildTakesTheSame: SameParameters<LoaderContext['log']['child'], ServerContext['log']['child']> = true;

// ctx.serve(handler): the request listener the server hands over is the one app.js's server calls.
export const handlerIsMutual: Mutual<LoaderHandler, ServerHandler> = true;
export const handlerTakesTheSame: SameParameters<LoaderHandler, ServerHandler> = true;

// server.mjs's exports are what app.js imports and calls: start(ctx) and runCli(argv, ctx) with app.js's context.
export function serverModuleIsWhatAppJsLoads(m: typeof Server): ServerModule {
  return m;
}
export const startTakesTheContext: SameParameters<typeof Server.start, (ctx: LoaderContext) => Promise<void>> = true;
export const runCliTakesArgvAndTheContext: Mutual<Parameters<typeof Server.runCli>[0], string[]> = true;
export const runCliTakesTheContext: Mutual<Parameters<typeof Server.runCli>[1], LoaderContext> = true;
