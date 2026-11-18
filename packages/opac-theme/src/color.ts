// Colour arithmetic of @altis/opac-theme: OKLCH (the perceptual space the palette is designed in) to sRGB hex, and the
// WCAG contrast ratio of two sRGB colours. The stylesheet writes every colour as hex, which every browser reads; the
// tests hold the palette to its contrast with the same functions. Pure, no dependency.

/** An sRGB colour as three channels 0-255. */
export type Rgb = readonly [number, number, number];

/** sRGB gamma encoding of a linear channel, clamped to 0-1. */
function encode(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** The sRGB colour of OKLCH lightness `l` (0-1), chroma `c` and hue `h` (degrees), clamped to the sRGB gamut. */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return linear.map((x) => Math.round(encode(x) * 255)) as unknown as Rgb;
}

/** `#rrggbb` of `rgb`. */
export function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** `#rrggbb` of an OKLCH colour. */
export function oklchHex(l: number, c: number, h: number): string {
  return rgbHex(oklchToRgb(l, c, h));
}

/** The channels of `#rrggbb`. */
export function hexRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new TypeError(`hexRgb: ${hex} is not #rrggbb`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** The WCAG relative luminance of an sRGB colour. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((x) => {
    const c = x / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(hexRgb(a));
  const y = luminance(hexRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The OKLCH lightness (0-1), chroma and hue (degrees, 0-360) of an sRGB colour. */
export function rgbToOklch(rgb: Rgb): [l: number, c: number, h: number] {
  const [r, g, b] = rgb.map((x) => {
    const c = x / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l1 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s1 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const l = 0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1;
  const a = 1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1;
  const bb = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return [l, Math.hypot(a, bb), h < 0 ? h + 360 : h];
}
