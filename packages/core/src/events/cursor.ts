// The event cursor (spec §10.6): `<dataEpoch>.<seq>`, both decimal integers of at least 0 without a sign or leading
// zeros. The epoch is the installation's data epoch (raised by a restore), so a cursor handed out before a restore
// never reads the restored database's events.

/** Two canonical decimal integers joined by one dot. */
const CURSOR = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * The cursor `"<epoch>.<seq>"`.
 *
 * @throws TypeError when `epoch` or `seq` is not a safe integer of at least 0
 */
export function formatCursor(epoch: number, seq: number): string {
  if (!isCount(epoch) || !isCount(seq)) {
    throw new TypeError('formatCursor: epoch and seq must be safe integers of at least 0');
  }
  return `${epoch}.${seq}`;
}

/** The parts of a cursor {@link formatCursor} writes; null for anything else (the reader answers 410 for it). */
export function parseCursor(s: string): { epoch: number; seq: number } | null {
  if (typeof s !== 'string') return null;
  const m = CURSOR.exec(s);
  if (m === null) return null;
  const epoch = Number(m[1]);
  const seq = Number(m[2]);
  return isCount(epoch) && isCount(seq) ? { epoch, seq } : null;
}
