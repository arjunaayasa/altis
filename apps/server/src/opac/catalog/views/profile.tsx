import type { Locale } from '@altis/shared';
import type { OpacHomeContent } from '@altis/shared/api/opac-home';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { opacText, type OpacKey } from '../messages.js';
import type { PublicLoanRule } from '../queries.js';
import { Photo, countText, keep, paragraphs, textIn } from '../site-blocks.js';

// The library's profile, `/profil`: its history with a timeline, its vision and mission, the people who run it (their
// names and roles as the staff typed them for publication; no member is ever read), its facilities, and how to become
// a member with the loan rules per member type. Each section only with content; a navigation of the page's sections
// stands beside them and needs no script. And the gallery, `/galeri`: every photo with its caption.

/** A member type's loan terms in words (`3 eksemplar, 7 hari`). */
export function ruleText(rule: PublicLoanRule, locale: Locale): string {
  const limit =
    rule.limit === null
      ? opacText(locale, 'home.rules.no_limit')
      : opacText(locale, rule.limit === 1 ? 'home.rules.items_one' : 'home.rules.items', { count: countText(rule.limit, locale) });
  const days =
    rule.days === 0 ? opacText(locale, 'home.rules.same_day') : opacText(locale, rule.days === 1 ? 'home.rules.days_one' : 'home.rules.days', { count: countText(rule.days, locale) });
  return `${limit}, ${days}`;
}

interface Section {
  id: string;
  /** The entry of the page's navigation. */
  label: OpacKey;
  body: JSX.Element;
}

/** The sections of the profile that have content, in order. */
function sections(o: { home: OpacHomeContent; rules: readonly PublicLoanRule[]; locale: Locale; lang: Locale | null; contentLang: Locale | undefined; hours: boolean }): Section[] {
  const { home, locale, contentLang } = o;
  const out: Section[] = [];
  const history = textIn(home.about.history, locale) ?? textIn(home.about.text, locale);
  const timeline = home.timeline ?? [];
  if (history !== null || timeline.length > 0) {
    out.push({
      id: 'sejarah',
      label: 'pages.profile.history',
      body: (
        <>
          <h2 id="sejarah-judul">{opacText(locale, 'pages.profile.history')}</h2>
          {history === null ? null : paragraphs(history.text).map((p) => <p lang={history.lang}>{p}</p>)}
          {timeline.length === 0 ? null : (
            <ol class="timeline">
              {timeline.map((entry) => {
                const text = textIn(entry.text, locale);
                return (
                  <li>
                    <span class="timeline-year">{entry.year}</span>
                    <p lang={text?.lang}>{text?.text ?? ''}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ),
    });
  }
  const vision = textIn(home.vision, locale);
  const mission = (home.mission ?? []).flatMap((m) => {
    const text = textIn(m, locale);
    return text === null ? [] : [text];
  });
  if (vision !== null || mission.length > 0) {
    out.push({
      id: 'visi',
      label: vision !== null && mission.length > 0 ? 'pages.profile.vision' : vision !== null ? 'pages.profile.vision_only' : 'pages.profile.mission_only',
      body: (
        <>
          <h2 id="visi-judul">
            {opacText(locale, vision !== null && mission.length > 0 ? 'pages.profile.vision' : vision !== null ? 'pages.profile.vision_only' : 'pages.profile.mission_only')}
          </h2>
          {vision === null ? null : (
            <blockquote class="vision" lang={vision.lang}>
              {vision.text}
            </blockquote>
          )}
          {mission.length === 0 ? null : (
            <ol class="mission">
              {mission.map((m) => (
                <li lang={m.lang}>
                  <span>{m.text}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      ),
    });
  }
  const staff = home.staff ?? [];
  if (staff.length > 0) {
    out.push({
      id: 'pengelola',
      label: 'pages.profile.staff',
      body: (
        <>
          <h2 id="pengelola-judul">{opacText(locale, 'pages.profile.staff')}</h2>
          <p>{opacText(locale, 'pages.profile.staff_lead')}</p>
          <ul class="people">
            {staff.map((person) => {
              const role = textIn(person.role, locale);
              return (
                <li>
                  <b>{person.name}</b>
                  {role === null ? null : <span lang={role.lang}>{role.text}</span>}
                </li>
              );
            })}
          </ul>
        </>
      ),
    });
  }
  if (home.facilities.length > 0) {
    out.push({
      id: 'fasilitas',
      label: 'pages.profile.facilities',
      body: (
        <>
          <h2 id="fasilitas-judul">{opacText(locale, 'pages.profile.facilities')}</h2>
          <ul class="facilities">
            {home.facilities.map((photo) => (
              <li>
                <Photo fileId={photo.fileId} alt={photo.alt} lang={contentLang}>
                  {photo.caption}
                </Photo>
              </li>
            ))}
          </ul>
        </>
      ),
    });
  }
  out.push({
    id: 'anggota',
    label: 'pages.profile.join',
    body: (
      <>
        <h2 id="anggota-judul">{opacText(locale, 'pages.profile.join')}</h2>
        <p>{opacText(locale, 'pages.profile.join_lead')}</p>
        <ol class="steps">
          <li>{opacText(locale, 'pages.profile.join_step1')}</li>
          <li>{opacText(locale, 'pages.profile.join_step2')}</li>
          <li>{opacText(locale, 'pages.profile.join_step3')}</li>
        </ol>
        {o.rules.length === 0 ? null : (
          <table class="rules" aria-label={opacText(locale, 'pages.profile.rules')}>
            <thead>
              <tr>
                <th scope="col">{opacText(locale, 'home.rules.type')}</th>
                <th scope="col">{opacText(locale, 'home.rules.terms')}</th>
              </tr>
            </thead>
            <tbody>
              {o.rules.map((r) => (
                <tr>
                  <th scope="row" lang={r.lang}>
                    {r.name}
                  </th>
                  <td>{ruleText(r, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="profile-actions">
          {o.hours ? (
            <a class="btn btn-outline" href={`${keep('/', o.lang)}#kunjungi`}>
              {opacText(locale, 'pages.profile.hours_link')}
            </a>
          ) : null}
          <a class="btn btn-outline" href={keep('/akun', o.lang)}>
            {opacText(locale, 'akun.header.link')}
          </a>
        </p>
      </>
    ),
  });
  return out;
}

/** The content of `/profil` in `locale`; `lang` is the language the request named (kept in every link). */
export function profileView(o: {
  home: OpacHomeContent;
  rules: readonly PublicLoanRule[];
  locale: Locale;
  lang: Locale | null;
  contentLang: Locale | undefined;
  /** The home page shows the opening hours (its visit block): the link to them. */
  hours: boolean;
}): JSX.Element {
  const list = sections(o);
  return (
    <div class="withnav">
      <nav class="sidenav" aria-label={opacText(o.locale, 'pages.profile.nav')}>
        {list.map((s) => (
          <a href={`#${s.id}`}>{opacText(o.locale, s.label)}</a>
        ))}
      </nav>
      <div>
        {list.map((s) => (
          <section class="psec" id={s.id} aria-labelledby={`${s.id}-judul`}>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}

/** The content of `/galeri`: every photo of the gallery with its caption. */
export function galleryView(o: { home: OpacHomeContent; locale: Locale }): JSX.Element {
  return (
    <ul class="gallery gallery-page">
      {(o.home.gallery ?? []).map((photo) => {
        const caption = textIn(photo.caption, o.locale);
        return (
          <li>
            <Photo fileId={photo.fileId} alt={photo.alt} lang={caption?.lang}>
              {caption?.text ?? null}
            </Photo>
          </li>
        );
      })}
    </ul>
  );
}
