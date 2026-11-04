import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code drawn as React SVG (Task 28; the `otpauth://` URI of 2FA enrolment). `qrcode-generator` computes the module
 * matrix only; the SVG is built here from `<rect>`s, never from the library's markup (no `dangerouslySetInnerHTML`,
 * spec §7.4). Each run of dark modules in a row is one rect, on a white square with the 4-module quiet zone the
 * standard asks for; black on white whatever the theme, so phone cameras read it. `crispEdges` keeps the modules
 * sharp at any size.
 */

/** The light margin around the code, in modules (ISO/IEC 18004). */
const QUIET_ZONE = 4;

interface Run {
  x: number;
  y: number;
  width: number;
}

/** The text as UTF-8 bytes, one character per byte: what the library's byte mode encodes (its default is Latin-1). */
function utf8Binary(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

/** The dark runs of `text`'s QR code (error correction M, smallest version that fits) and the matrix size. */
function qrRuns(text: string): { size: number; runs: Run[] } {
  const qr = qrcode(0, 'M');
  qr.addData(utf8Binary(text), 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const runs: Run[] = [];
  for (let row = 0; row < size; row += 1) {
    let start = -1;
    for (let col = 0; col <= size; col += 1) {
      const dark = col < size && qr.isDark(row, col);
      if (dark && start < 0) start = col;
      if (!dark && start >= 0) {
        runs.push({ x: start + QUIET_ZONE, y: row + QUIET_ZONE, width: col - start });
        start = -1;
      }
    }
  }
  return { size, runs };
}

/** The QR code of `text`; `label` names it for assistive technology (it is an image). */
export function QrCode({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { size, runs } = useMemo(() => qrRuns(text), [text]);
  const full = size + 2 * QUIET_ZONE;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${full} ${full}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect x={0} y={0} width={full} height={full} fill="#fff" />
      {runs.map((run) => (
        <rect key={`${run.y}:${run.x}`} x={run.x} y={run.y} width={run.width} height={1} fill="#000" />
      ))}
    </svg>
  );
}
