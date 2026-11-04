import { TOTP, base32Decode, hotp, totpStep } from '@altis/core';

// The authenticator app of an E2E user: the TOTP codes of a secret read from the enrolment page (or the setup API),
// computed with the server's own `hotp` (Task 5).
//
// The server accepts the steps s-1, s and s+1 around its clock, and never a step at or before the user's
// `totp_last_step` (spec §7.1: no code reuse). A flow that needs several codes in a row (enable, then sign in, then
// sign in on another device) therefore takes the next unused step each time: the current one, then one ahead, and
// once that window is used up it waits for the next step to begin (at most one period, 30 s).

const PERIOD_MS = TOTP.periodS * 1000;
/** How far past the start of a step a wait ends, so that the server's clock (the same machine) is in it too. */
const STEP_MARGIN_MS = 250;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

export class Authenticator {
  readonly #key: Uint8Array;
  readonly #clock: Clock;
  #lastStep = -1;

  /**
   * @param secret base32 as the enrolment page shows it (groups of four) or the setup API answers it
   * @throws Error when `secret` is empty or not base32
   */
  constructor(secret: string, clock: Clock = SYSTEM_CLOCK) {
    if (secret.trim() === '') throw new Error('Authenticator: the secret is empty');
    let key: Uint8Array;
    try {
      key = base32Decode(secret);
    } catch (error) {
      throw new Error('Authenticator: the secret is not base32 text', { cause: error });
    }
    if (key.length === 0) throw new Error('Authenticator: the secret is not base32 text');
    this.#key = key;
    this.#clock = clock;
  }

  /** The code of the next step the server has not seen from this app, waiting for it when it lies too far ahead. */
  async nextCode(): Promise<string> {
    const current = totpStep(this.#clock.now());
    const step = Math.max(current, this.#lastStep + 1);
    // The server would refuse `step` before step-1 begins: wait for it.
    if (step > current + 1) await this.#clock.sleep((step - 1) * PERIOD_MS - this.#clock.now() + STEP_MARGIN_MS);
    this.#lastStep = step;
    return hotp(this.#key, step, TOTP.digits);
  }
}
