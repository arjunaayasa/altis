import { recordUrlPath } from '@altis/core';
import type { DbHandle } from '@altis/db';
import type { Locale } from '@altis/shared';
import { opacText } from './messages.js';
import { withLang } from './urls.js';

// A result of the OPAC search (Phase 2 Task 33; spec §4, §9.1): the light projection a card shows, read for the ids of
// one page in one pass (three queries whatever the page size): the record's title, subtitle, year, cover and material
// type, its main agent (`is_main`, the first by `sort_order`), and whether it is available now (the `av` facet the
// index wrote: an `available` item in a public location, §4.6). No RecordData is loaded. The feeds read the same.
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
  /** The record's `created_at` (epoch ms): a feed item's `pubDate`. */
  createdAt: number;
}

/** The cards of `ids`, in that order; an id that is no longer public is left out. */
export async function resultCards(db: Db, ids: readonly string[]): Promise<ResultCardData[]> {
  if (ids.length === 0) return [];
  const wanted = [...new Set(ids)];
  const [records, agents, available] = await Promise.all([
    db
      .selectFrom('records')
      .select(['id', 'title', 'subtitle', 'publication_year', 'cover_file_id', 'material_type_id', 'created_at'])
      .where('id', 'in', wanted)
      .where('opac_visible', '=', 1)
      .where('archived_at', 'is', null)
      .where('merged_into', 'is', null)
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
    db.selectFrom('search_facet').select('record_id').where('facet', '=', 'av').where('value_key', '=', '1').where('record_id', 'in', wanted).execute(),
  ]);
  const mainAgent = new Map<string, string>();
  for (const r of agents) if (!mainAgent.has(r.record_id)) mainAgent.set(r.record_id, r.name_display);
  const isAvailable = new Set(available.map((r) => r.record_id));
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
        createdAt: Number(r.created_at),
      },
    ];
  });
}

/** The title of a card as one line (`Title: subtitle`), for a feed. */
export function cardTitle(card: Pick<ResultCardData, 'title' | 'subtitle'>): string {
  return card.subtitle === null || card.subtitle.trim() === '' ? card.title : `${card.title}: ${card.subtitle}`;
}

/** A result card: cover, title linking to the record, main agent, year and material type, availability. */
export function ResultCard(props: { card: ResultCardData; materialType: string | null; locale: Locale; lang: Locale | null }) {
  const { card, materialType, locale, lang } = props;
  const href = recordUrlPath(card.id, card.title);
  const meta = [card.year, materialType].filter((x): x is string => x !== null && x.trim() !== '').join(' · ');
  return (
    <li class="card">
      {card.coverFileId === null ? (
        <span class="card-cover" aria-hidden="true"></span>
      ) : (
        <img class="card-cover" src={`/files/${encodeURIComponent(card.coverFileId)}`} alt="" loading="lazy" decoding="async" width={120} height={180} />
      )}
      <span class="card-body">
        <a class="card-title" href={lang === null ? href : withLang(href, lang)}>
          {card.title}
          {card.subtitle === null || card.subtitle.trim() === '' ? null : <span class="card-subtitle">: {card.subtitle}</span>}
        </a>
        {card.mainAgent === null ? null : <span class="card-meta">{card.mainAgent}</span>}
        {meta === '' ? null : <span class="card-meta">{meta}</span>}
        {card.available ? (
          <span class="card-badges">
            <span class="status status-ok">{opacText(locale, 'search.card.available')}</span>
          </span>
        ) : null}
      </span>
    </li>
  );
}
