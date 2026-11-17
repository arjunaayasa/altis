import { SHELL_CSS } from '@altis/opac-theme';
import { LOCALES, t } from '@altis/shared';
import { jsx } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import { AvailabilitySection, type Availability, type AvailabilityRow } from '../src/opac/catalog/availability.js';
import { opacText } from '../src/opac/catalog/messages.js';

// The availability table of a title on a phone: below 40 rem each copy is a card (CSS only, the page keeps its strict
// CSP), its status first, so that the status never hides past the right edge of a five-column table. The markup gives
// each cell what the card needs: the status cell its class, every other cell its column's name in `data-label`.

/** The server render of a view (hono's jsx() from a .ts file). */
const render = (view: unknown, props: Record<string, unknown>): string => String(jsx(view as never, props as never));

const row = (id: string, o: Partial<AvailabilityRow> = {}): AvailabilityRow => ({
  id,
  branch: 'Perpustakaan Pusat',
  place: null,
  hint: null,
  callNumber: '910.2 TIM a',
  barcode: `B${id}`,
  status: 'available',
  dueOn: null,
  onHold: false,
  state: 'shelf',
  ...o,
});

const availability: Availability = {
  rows: [row('1', { dueOn: '2026-11-20', state: 'loan' }), row('2', { status: 'repair', state: 'other' }), row('3')],
  total: 3,
  available: 1,
  maps: [],
  status: null,
};

/** The attributes of every <td> of `html`, in order. */
function cells(html: string): Record<string, string>[] {
  return [...html.matchAll(/<td(\s[^>]*)?>/g)].map((m) => Object.fromEntries([...(m[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));
}

describe('the availability table as cards on a phone', () => {
  it('each row: four cells named by their column, then the status cell', () => {
    for (const locale of LOCALES) {
      const html = render(AvailabilitySection, { availability, locale });
      const all = cells(html);
      expect(all).toHaveLength(15);
      const names = [opacText(locale, 'detail.col.branch'), opacText(locale, 'detail.col.location'), t(locale, 'vocab.field.call_number'), opacText(locale, 'detail.col.barcode')];
      for (let i = 0; i < all.length; i += 5) {
        expect(all.slice(i, i + 4).map((c) => c['data-label'])).toEqual(names);
        expect(all[i + 4]).toEqual({ class: 'availability-status' });
      }
      // The header row stays, for wide screens and screen readers.
      expect(html).toContain(`<th scope="col">${opacText(locale, 'detail.col.status')}</th>`);
    }
  });

  it('the CSS: below 40 rem the rows are cards, the status first, each other cell under its column name', () => {
    const phone = /@media \(max-width:39\.99rem\)\{([^@]*?)\}\n/.exec(SHELL_CSS)?.[1] ?? '';
    expect(phone).toContain('.availability tr{display:flex;flex-direction:column;');
    expect(phone).toContain('.availability .availability-status{order:-1;');
    expect(phone).toContain('.availability td[data-label]::before{content:attr(data-label);');
    expect(phone).toMatch(/\.availability thead\{position:absolute;width:1px;height:1px;/);
  });
});
