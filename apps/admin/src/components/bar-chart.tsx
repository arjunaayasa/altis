import { useId, useRef } from 'react';
import { useBoxWidth } from '@/lib/box-width';
import { cn } from '@/lib/utils';

/**
 * A compact bar chart drawn as our own SVG (no chart library): one series, so one hue (the theme's first chart series,
 * `--series-1`, set for light and for dark) and no legend, the title naming the series. It is a picture of figures a table
 * beside it holds: the SVG is `role="img"` with a `<title>` and a `<desc>` (the number of bars, the highest value, and
 * that the table holds every figure), and each bar's slot carries its label and value as a native tooltip.
 *
 * - No bars: nothing is drawn (the table says it is empty).
 * - One bar, or a few: a bar is never wider than {@link MAX_BAR}, centred in its slot, so one bar is a bar, not a
 *   block across the card.
 * - All zero: the bars lie flat on the baseline (the scale tops at 1, never divides by 0).
 * - More than `maxBars`: the first `maxBars` are drawn and the description says so.
 *
 * Marks are thin with a 2-unit gap between bars and rounded top ends; the baseline is the only rule; labels are text
 * tokens (all of them up to {@link ALL_LABELS} bars, else the first and the last), and only the highest bar carries its
 * value.
 *
 * The drawing is as wide as its box is (measured; {@link WIDTH} before that), one unit a pixel: its labels keep their
 * size on a phone instead of shrinking with the picture, and a narrow slot clips its label shorter.
 */

export interface ChartBar {
  label: string;
  value: number;
}

const WIDTH = 600;
const HEIGHT = 150;
const TOP = 16;
const BOTTOM = 22;
const GAP = 2;
const MAX_BAR = 40;
const ALL_LABELS = 12;
const LABEL_CHARS = 12;

const clip = (s: string, n: number): string => (Array.from(s).length <= n ? s : `${Array.from(s).slice(0, n - 1).join('')}…`);

export function BarChart({
  title,
  description,
  bars,
  format,
  maxBars = 40,
  className,
}: {
  title: string;
  /** What a screen reader hears after the title: the shape of the data and where its figures are. */
  description: string;
  bars: readonly ChartBar[];
  format(value: number): string;
  maxBars?: number;
  className?: string;
}) {
  const titleId = useId();
  const descId = useId();
  const box = useRef<HTMLDivElement>(null);
  const width = useBoxWidth(box, WIDTH);
  if (bars.length === 0) return null;
  const shown = bars.slice(0, Math.max(1, maxBars));
  const values = shown.map((b) => (Number.isFinite(b.value) && b.value > 0 ? b.value : 0));
  const max = Math.max(0, ...values);
  const top = max > 0 ? max : 1;
  const plot = HEIGHT - TOP - BOTTOM;
  const slot = width / shown.length;
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const highest = values.indexOf(max);
  const labelled = (k: number): boolean => shown.length <= ALL_LABELS || k === 0 || k === shown.length - 1;
  return (
    <figure className={cn('flex flex-col gap-1', className)} data-chart="">
      <figcaption className="text-meta font-semibold text-muted-foreground">{title}</figcaption>
      <div ref={box} className="w-full max-w-3xl">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          className="block h-auto w-full overflow-visible"
          preserveAspectRatio="xMidYMid meet">
          <title id={titleId}>{title}</title>
          <desc id={descId}>{description}</desc>
          <line x1={0} x2={width} y1={TOP + plot} y2={TOP + plot} className="stroke-border" strokeWidth={1} />
          {shown.map((b, k) => {
            const h = (values[k]! / top) * plot;
            const x = k * slot + (slot - barWidth) / 2;
            const y = TOP + plot - h;
            const r = Math.min(4, barWidth / 2, h);
            // A rounded top and a square foot on the baseline.
            const path =
              h <= 0
                ? null
                : `M${x},${TOP + plot} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${TOP + plot} Z`;
            return (
              <g key={k} data-bar={b.label}>
                <rect x={k * slot} y={0} width={slot} height={HEIGHT} fill="transparent">
                  <title>{`${b.label}: ${format(b.value)}`}</title>
                </rect>
                {path !== null && <path d={path} className="pointer-events-none fill-series-1" />}
                {k === highest && max > 0 && (
                  <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" className="pointer-events-none fill-foreground text-[11px] tabular-nums">
                    {format(b.value)}
                  </text>
                )}
                {labelled(k) && (
                  <text
                    x={shown.length <= ALL_LABELS ? k * slot + slot / 2 : k === 0 ? 0 : width}
                    y={HEIGHT - 6}
                    textAnchor={shown.length > ALL_LABELS ? (k === 0 ? 'start' : 'end') : 'middle'}
                    className="pointer-events-none fill-faint text-[11px]">
                    {clip(b.label, shown.length > ALL_LABELS ? LABEL_CHARS * 2 : Math.max(4, Math.floor(slot / 6)))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
