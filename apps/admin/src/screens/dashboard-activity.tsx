import type { DeskHour } from '@altis/shared/api/dashboard-home';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { useCount, useDeskToday } from '@/screens/dashboard-today';

/**
 * "Aktivitas meja hari ini" on Beranda: the loans and returns of today at the desk's branch per local hour of the
 * branch, as two bar series drawn as our own SVG (no chart library, as the report charts), with a legend, a tooltip that
 * follows the pointer and the keyboard, and the same figures as a table.
 *
 * - The hours shown run from 07.00 to 16.00, widened to any hour that has a loan or a return; an hour with nothing
 *   still shows (an empty slot). A day with nothing at all shows one sentence instead of an empty chart.
 * - The chart is drawn in the pixels of its box (measured), so its text stays legible on a phone.
 * - Keyboard: the hours are one tab stop; the left and right arrow keys (Home, End) move between them, and the tooltip
 *   shows the hour that has focus. Each hour is labelled for a screen reader, and the table holds every figure.
 * - Colours: the two chart series of the theme (`--series-1`, `--series-2`), with fallbacks.
 */

const SERIES_LOANS = 'var(--series-1, #2a78d6)';
const SERIES_RETURNS = 'var(--series-2, #eb6834)';

const HEIGHT = 220;
const TOP = 10;
const BOTTOM = 24;
const LEFT = 32;
const RIGHT = 4;
const MAX_BAR = 18;
const TIP_WIDTH = 168;

/** The hours shown at least: 07.00 to 16.00. */
const DAY_FIRST = 7;
const DAY_LAST = 16;

/** The hours the chart shows: DAY_FIRST to DAY_LAST, widened to every hour with a loan or a return. */
export function shownHours(hours: readonly DeskHour[]): DeskHour[] {
  const busy = hours.filter((h) => h.loans + h.returns > 0).map((h) => h.hour);
  const first = Math.min(DAY_FIRST, ...busy);
  const last = Math.max(DAY_LAST, ...busy);
  return hours.filter((h) => h.hour >= first && h.hour <= last);
}

/** An axis for values up to `max`: whole steps of 1, 2 or 5 times a power of ten, about four of them. */
export function axisScale(max: number): { top: number; step: number } {
  const raw = Math.max(1, max) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, Math.ceil([1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw));
  return { top: Math.max(step, Math.ceil(Math.max(1, max) / step) * step), step };
}

/** The local time of the start of `hour` as the UI language writes it: `08.00` (id) or `08:00` (en). */
function useClock(): (hour: number) => string {
  const locale = useLocale();
  return (hour: number) => `${String(hour % 24).padStart(2, '0')}${locale === 'en' ? ':' : '.'}00`;
}

/** The width of `ref`'s box, measured (`fallback` before the first measure, or where nothing measures). */
function useBoxWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A bar with a rounded top and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string | null {
  if (h <= 0) return null;
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function ActivityChart({ hours }: { hours: readonly DeskHour[] }) {
  const t = useT();
  const count = useCount();
  const clock = useClock();
  const titleId = useId();
  const descId = useId();
  const box = useRef<HTMLDivElement>(null);
  const width = useBoxWidth(box, 640);
  const [active, setActive] = useState<number | null>(null);
  const [focusAt, setFocusAt] = useState(0);
  const [focused, setFocused] = useState(false);
  const slots = useRef<(SVGGElement | null)[]>([]);

  const n = hours.length;
  const { top, step } = axisScale(Math.max(0, ...hours.map((h) => Math.max(h.loans, h.returns))));
  const plot = HEIGHT - TOP - BOTTOM;
  const y = (v: number): number => TOP + plot * (1 - v / top);
  const slot = (width - LEFT - RIGHT) / n;
  const bar = Math.max(3, Math.min(MAX_BAR, (slot - 8) / 2));
  const everyLabel = slot >= 40;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, k) => k * step);
  const label = (h: DeskHour) => t('dashboard.home.activity.slot', { from: clock(h.hour), to: clock(h.hour + 1), loans: count(h.loans), returns: count(h.returns) });

  const move = (k: number) => {
    const next = Math.max(0, Math.min(n - 1, k));
    setFocusAt(next);
    slots.current[next]?.focus();
  };
  const onKey = (e: KeyboardEvent, k: number) => {
    const to = e.key === 'ArrowRight' ? k + 1 : e.key === 'ArrowLeft' ? k - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (to === null) return;
    e.preventDefault();
    move(to);
  };

  const shown = active === null ? null : hours[active];
  const tipLeft = active === null ? 0 : Math.max(0, Math.min(width - TIP_WIDTH, LEFT + slot * active + slot / 2 - TIP_WIDTH / 2));
  return (
    <div ref={box} className="relative" data-activity-chart="">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="group" aria-labelledby={titleId} aria-describedby={descId} className="block max-w-full">
        <title id={titleId}>{t('dashboard.home.activity.chart')}</title>
        <desc id={descId}>{t('dashboard.home.activity.desc', { from: clock(hours[0]!.hour), to: clock(hours[n - 1]!.hour + 1) })}</desc>
        {ticks.map((v) => (
          <g key={v} aria-hidden="true">
            <line x1={LEFT} x2={width - RIGHT} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
            <text x={LEFT - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
              {count(v)}
            </text>
          </g>
        ))}
        {hours.map((h, k) => {
          const cx = LEFT + slot * k + slot / 2;
          const loans = barPath(cx - bar - 1, y(h.loans), bar, y(0) - y(h.loans));
          const returns = barPath(cx + 1, y(h.returns), bar, y(0) - y(h.returns));
          return (
            <g
              key={h.hour}
              ref={(el) => {
                slots.current[k] = el;
              }}
              data-hour={h.hour}
              role="img"
              aria-label={label(h)}
              tabIndex={k === focusAt ? 0 : -1}
              className="outline-none"
              onMouseEnter={() => setActive(k)}
              onMouseLeave={() => setActive((a) => (a === k && !focused ? null : a))}
              onMouseDown={(e) => e.preventDefault()}
              onFocus={() => {
                setFocused(true);
                setFocusAt(k);
                setActive(k);
              }}
              onBlur={() => {
                setFocused(false);
                setActive(null);
              }}
              onKeyDown={(e) => onKey(e, k)}>
              <rect x={LEFT + slot * k} y={TOP} width={slot} height={plot} className={active === k ? 'fill-muted' : 'fill-transparent'} />
              {focused && focusAt === k && (
                <rect x={LEFT + slot * k + 1} y={TOP + 1} width={slot - 2} height={plot - 2} rx={4} className="fill-none stroke-ring" strokeWidth={2} />
              )}
              {loans !== null && <path d={loans} style={{ fill: SERIES_LOANS }} />}
              {returns !== null && <path d={returns} style={{ fill: SERIES_RETURNS }} />}
              {(everyLabel || k % 2 === 0) && (
                <text x={cx} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums" aria-hidden="true">
                  {clock(h.hour)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown !== null && shown !== undefined && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
          style={{ left: tipLeft, width: TIP_WIDTH }}
          data-activity-tip="">
          <b className="block font-semibold">{t('dashboard.home.activity.hour', { from: clock(shown.hour), to: clock(shown.hour + 1) })}</b>
          {t('dashboard.home.activity.tip', { loans: count(shown.loans), returns: count(shown.returns) })}
        </div>
      )}
    </div>
  );
}

/** The figures of the chart as a table, folded away by default. */
function ActivityTable({ hours }: { hours: readonly DeskHour[] }) {
  const t = useT();
  const count = useCount();
  const clock = useClock();
  return (
    <details className="text-sm">
      <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">{t('dashboard.home.table.show')}</summary>
      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse tabular-nums">
          <caption className="sr-only">{t('dashboard.home.activity.chart')}</caption>
          <thead>
            <tr className="bg-muted/60 text-xs text-muted-foreground">
              <th scope="col" className="border-b px-3 py-2 text-left font-semibold">
                {t('dashboard.home.table.hour')}
              </th>
              <th scope="col" className="border-b px-3 py-2 text-right font-semibold">
                {t('dashboard.home.activity.loans')}
              </th>
              <th scope="col" className="border-b px-3 py-2 text-right font-semibold">
                {t('dashboard.home.activity.returns')}
              </th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.hour} className="border-b last:border-b-0">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  {t('dashboard.home.activity.hour', { from: clock(h.hour), to: clock(h.hour + 1) })}
                </th>
                <td className="px-3 py-1.5 text-right">{count(h.loans)}</td>
                <td className="px-3 py-1.5 text-right">{count(h.returns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** The legend of the two series. */
function Legend() {
  const t = useT();
  const swatch = (color: string) => <i aria-hidden="true" className="mr-1.5 inline-block size-2.5 rounded-[2px] align-[-1px]" style={{ background: color }} />;
  return (
    <p className="flex gap-4 text-[13px] text-muted-foreground" data-legend="">
      <span>
        {swatch(SERIES_LOANS)}
        {t('dashboard.home.activity.loans')}
      </span>
      <span>
        {swatch(SERIES_RETURNS)}
        {t('dashboard.home.activity.returns')}
      </span>
    </p>
  );
}

/** "Aktivitas meja hari ini" (see the top of this file); nothing without a desk branch. */
export function DeskActivity() {
  const t = useT();
  const headingId = useId();
  const { desk, query } = useDeskToday();
  if (desk.branchId === null) return null;
  const data = query.data;
  const empty = data !== undefined && data.hours.every((h) => h.loans + h.returns === 0);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3" data-desk-activity="">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-bold">
          {t('dashboard.home.activity.title')}
        </h2>
        {data !== undefined && !empty && <Legend />}
      </div>
      {data === undefined ? (
        query.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm">
            <span className="font-bold text-destructive">{t('dashboard.home.activity.failed')}</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t('table.retry')}
            </Button>
          </div>
        ) : (
          <div className="h-[220px] animate-pulse rounded-lg bg-muted motion-reduce:animate-none" aria-hidden="true" />
        )
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.home.activity.empty')}</p>
      ) : (
        <>
          <ActivityChart hours={shownHours(data.hours)} />
          <ActivityTable hours={shownHours(data.hours)} />
        </>
      )}
    </section>
  );
}
