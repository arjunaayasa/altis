// The `visits` module of @altis/opac-theme (Komunitas K2): the guestbook station's pages (`/kunjungan`), shown full
// screen on a library device. Large type and targets, the scan box first; the tokens come from base.ts, so both colour
// schemes and every accent apply. Nothing fetched.
//
// - `.guestbook` is the station's column; `.guestbook-scan` the member number box; `.guestbook-actions` the guest and submit
//   buttons; `.guestbook-greeting` the answer after a check-in (`.is-warning` for an expired membership, `.is-error` for a
//   number nobody holds); `.guestbook-code` the activation code box.

/** The CSS of the guestbook station. */
export const VISITS_CSS: string = [
  '.guestbook{max-width:40rem;margin:2rem auto;text-align:center}',
  '.guestbook h1{font-size:1.875rem;line-height:1.2;margin:0 0 .5rem}',
  '.guestbook-welcome{font-size:1.25rem;color:var(--muted);margin:0 0 2rem}',
  '.guestbook form{display:grid;gap:1rem;text-align:left}',
  '.guestbook label{font-weight:600}',
  '.guestbook input,.guestbook select{width:100%;min-height:3.5rem;padding:.5rem 1rem;font-size:1.5rem;' +
    'border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)}',
  '.guestbook-scan{font-family:var(--mono)}',
  '.guestbook-code{font-family:var(--mono);text-transform:uppercase;text-align:center}',
  '.guestbook-actions{display:flex;flex-wrap:wrap;gap:1rem;justify-content:center}',
  '.guestbook button,.guestbook-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:3.5rem;' +
    'padding:0 1.5rem;font:600 1.125rem var(--font);border-radius:var(--radius-sm);border:1px solid var(--accent);text-decoration:none;cursor:pointer}',
  '.guestbook button{background:var(--accent);color:var(--accent-ink)}',
  '.guestbook-actions a{background:var(--bg);border-color:var(--border-strong);color:var(--text)}',
  '.guestbook-greeting{margin:2rem 0;padding:2rem 1rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);font-size:1.75rem}',
  '.guestbook-greeting.is-warning{border-left-color:var(--warn)}',
  '.guestbook-greeting.is-error{border-left-color:var(--danger)}',
  '.guestbook-greeting p{margin:.5rem 0 0;font-size:1.125rem;color:var(--muted)}',
  '.guestbook-photo{display:block;width:9rem;height:12rem;object-fit:cover;margin:0 auto 1rem;border-radius:var(--radius)}',
  '.guestbook-error{color:var(--danger);font-weight:600}',
].join('\n');
