import { recordUrlPath } from '@altis/core';
import type { DbHandle } from '@altis/db';
import type { Locale } from '@altis/shared';
import { BookCover } from './cover.js';
import { opacText, type OpacKey } from './messages.js';
import { withLang } from './urls.js';

// A result of the OPAC search (Phase 2 Task 33; spec §4, §9.1): the light projection a card shows, read for the ids of
// one page in one pass (three queries whatever the page size): the record's title, subtitle, year, cover, material
// type, publisher, call number and classification, its main agent (`is_main`, the first by `sort_order`), and whether
// it is available now (the `av` facet the index wrote: an `available` item in a public location, §4.6) or has copies
// none of which is (`br` without `av`). No RecordData is loaded. The feeds read the same.
//
// The search answered ids from `search_doc`; each is checked against `records` once more (opac_visible, not archived,
// not merged), so a record hidden or archived between the two reads is left out rather than shown.

type Db = DbHandle['db'];

/** One record as a result card (and a feed item) shows it. */
export interface ResultCardData {
  id: string;
  title: string;
  subtitle: string | null;
  /** CHAR(4) as catalogued. */
  year: string | null;
  coverFileId: string | null;
  materialTypeId: string;
  /** The display name of the main agent, if any. */
  mainAgent: string | null;
  /** An `available` item in a public location (facet `av`). */
  available: boolean;
  // ---- Komunitas (OPAC look) ----
  /** The title has copies but none is on an open shelf now (facet `br` without `av`). */
  offShelf: boolean;
  /** The publisher's display name, or null. */
  publisher: string | null;
  callNumber: string | null;
  classification: string | null;
  /** The record's `created_at` (epoch ms): a feed item's `pubDate`. */
  createdAt: number;
}

/** The cards of `ids`, in that order; an id that is no longer public is left out. */
export async function resultCards(db: Db, ids: readonly string[]): Promise<ResultCardData[]> {
  if (ids.length === 0) return [];
  const wanted = [...new Set(ids)];
  const [records, agents, available] = await Promise.all([
    db
      .selectFrom('records as r')
      .leftJoin('publishers as p', 'p.id', 'r.publisher_id')
      .select([
        'r.id',
        'r.title',
        'r.subtitle',
        'r.publication_year',
        'r.cover_file_id',
        'r.material_type_id',
        'r.created_at',
        'r.call_number',
        'r.classification',
        'p.name_display as publisher',
      ])
      .where('r.id', 'in', wanted)
      .where('r.opac_visible', '=', 1)
      .where('r.archived_at', 'is', null)
      .where('r.merged_into', 'is', null)
      .execute(),
    db
      .selectFrom('record_agents as ra')
      .innerJoin('agents as a', 'a.id', 'ra.agent_id')
      .select(['ra.record_id', 'a.name_display'])
      .where('ra.record_id', 'in', wanted)
      .where('ra.is_main', '=', 1)
      .orderBy('ra.record_id')
      .orderBy('ra.sort_order')
      .execute(),
    db.selectFrom('search_facet').select(['record_id', 'facet']).where('facet', 'in', ['av', 'br']).where('record_id', 'in', wanted).execute(),
  ]);
  const mainAgent = new Map<string, string>();
  for (const r of agents) if (!mainAgent.has(r.record_id)) mainAgent.set(r.record_id, r.name_display);
  const isAvailable = new Set(available.filter((r) => r.facet === 'av').map((r) => r.record_id));
  const hasCopies = new Set(available.filter((r) => r.facet === 'br').map((r) => r.record_id));
  const byId = new Map(records.map((r) => [r.id, r]));
  return wanted.flatMap((id) => {
    const r = byId.get(id);
    if (r === undefined) return [];
    return [
      {
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        // CHAR(4): PostgreSQL pads a shorter value with spaces.
        year: r.publication_year === null || r.publication_year.trim() === '' ? null : r.publication_year.trim(),
        coverFileId: r.cover_file_id,
        materialTypeId: r.material_type_id,
        mainAgent: mainAgent.get(r.id) ?? null,
        available: isAvailable.has(r.id),
        offShelf: !isAvailable.has(r.id) && hasCopies.has(r.id),
        publisher: r.publisher === null || r.publisher.trim() === '' ? null : r.publisher,
        callNumber: r.call_number === null || r.call_number.trim() === '' ? null : r.call_number.trim(),
        classification: r.classification,
        createdAt: Number(r.created_at),
      },
    ];
  });
}

/** The title of a card as one line (`Title: subtitle`), for a feed. */
export function cardTitle(card: Pick<ResultCardData, 'title' | 'subtitle'>): string {
  return card.subtitle === null || card.subtitle.trim() === '' ? card.title : `${card.title}: ${card.subtitle}`;
}

/** The DDC main class of a classification as the facets name it (`800 Kesusastraan`), or null. */
function classLabel(classification: string | null, locale: Locale): string | null {
  const c = (classification ?? '').trim();
  return /^[0-9]/.test(c) ? `${c[0]!}00 ${opacText(locale, `shell.home.class.${c[0]!}` as OpacKey)}` : null;
}

/**
 * A result: a row of the list with a thin line under it: the cover (or the cloth strip of the substitute cover), the
 * title linking to the record, the main agent with the publisher and year, the call number with the class and the
 * material type, and the availability in words.
 */
export function ResultCard(props: { card: ResultCardData; materialType: string | null; locale: Locale; lang: Locale | null }) {
  const { card, materialType, locale, lang } = props;
  const href = recordUrlPath(card.id, card.title);
  const published = [card.publisher, card.year].filter((x): x is string => x !== null && x.trim() !== '').join(', ');
  const line = [card.mainAgent, published].filter((x): x is string => x !== null && x !== '').join(' · ');
  const kind = [classLabel(card.classification, locale), materialType].filter((x): x is string => x !== null && x.trim() !== '');
  return (
    <li class="card">
      <BookCover
        book={{ title: card.title, author: card.mainAgent, callNumber: card.callNumber, classification: card.classification, coverFileId: card.coverFileId }}
        size="list"
        imgClass="card-cover"
        width={120}
        height={180}
      />
      <span class="card-body">
        <a class="card-title" href={lang === null ? href : withLang(href, lang)}>
          {card.title}
          {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
        </a>
        {line === '' ? null : <span class="result-line">{line}</span>}
        {card.callNumber === null && kind.length === 0 ? null : (
          <span class="card-meta">
            {card.callNumber === null ? null : (
              <>
                {opacText(locale, 'search.card.call_number')} <span class="call-number">{card.callNumber}</span>
                {kind.length === 0 ? null : ' · '}
              </>
            )}
            {kind.join(' · ')}
          </span>
        )}
        {card.available ? (
          <span class="card-badges">
            <span class="status status-ok">{opacText(locale, 'search.card.available')}</span>
          </span>
        ) : card.offShelf ? (
          <span class="card-badges">
            <span class="status status-muted">{opacText(locale, 'search.card.off_shelf')}</span>
          </span>
        ) : null}
      </span>
    </li>
  );
}
