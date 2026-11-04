# AGENTS.md: guide for coding agents and contributors

ALTIS (Arsya Library Tracking Information System), Edisi Komunitas: a self-hosted library automation system in
TypeScript (Hono, React, Kysely), licensed AGPL-3.0-only. Human contributors: read [CONTRIBUTING.md](CONTRIBUTING.md)
as well; it holds the contributor licence grant every pull request needs.

## Communication

- Talk to the maintainer, and write issue and PR text for them, in **Bahasa Indonesia**. English is accepted.
- Code identifiers, commit messages and code comments are in English.
- User-facing text exists in Indonesian **and** English, with the same keys in both catalogs (tests check parity).

## Repository layout

| Path | What it is |
|---|---|
| `apps/server` | The HTTP server (Hono): the JSON API, the install wizard API, the CLI (`node app.js <command>`) and the OPAC, rendered on the server with `hono/jsx` |
| `apps/admin` | The admin SPA (React, Vite) and the install wizard pages |
| `packages/core` | Domain logic: catalogue, search, imports and exports, SLiMS migration, jobs, backups, updates, the edition seam |
| `packages/db` | Kysely dialects (SQLite, MySQL/MariaDB, PostgreSQL), the schema and the append-only migrations |
| `packages/shared` | Types shared by server and admin: API contracts, errors, permissions, audit actions, i18n catalogs |
| `packages/crypto` | Ed25519 envelopes, keysets, the release manifest and (`@altis/crypto/feed`) the update feed format |
| `packages/platform` | Runtime detection, `DATA_DIR` paths, file locks, atomic writes |
| `packages/bootloader` | `app.js`: verifies the signed release and boots it; frozen per install |
| `packages/opac-theme` | The OPAC stylesheet |
| `tools/release` | `pnpm release` (the zip), the smoke, N−1 and perf runs, the update feed builder |
| `tools/sign-cli` | `altis-sign`: key generation and the signing of releases, keysets, feeds and freshness documents |
| `tools/e2e` | Playwright end-to-end suite (`pnpm e2e`) |
| `tools/test` | Test database engines (`tools/test/compose.yml`) and the DB test setup |
| `tools/keys/dev` | **Public** development keys: test fixtures only, never trusted by a production build |
| `docs/install`, `docs/ops` | Install guides (Indonesian) and operations rules; `docs/ops/release-signing.md` for release keys |

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check                 # tsc -b + eslint; must pass before every commit
pnpm test                  # unit + admin projects
docker compose -f tools/test/compose.yml up -d --wait mailpit <engine>
ALTIS_TEST_DB=<engine> pnpm test:db                       # the whole DB project on one engine
ALTIS_TEST_DB=<engine> pnpm exec vitest run --project db <files>   # only the DB test files you touched
pnpm e2e                   # Playwright; builds the -test release itself
pnpm release --profile test --version 0.1.0-test          # an evaluation zip in dist/
```

Engines: `sqlite`, `mysql80`, `mysql84`, `mariadb106`, `mariadb114`, `pg15`, `pg17`. Run DB tests on SQLite and on at
least one server engine (MariaDB/MySQL or PostgreSQL) when you touch SQL. Put agent worktrees under
`.claude/worktrees/` (ignored by git and by every Vitest project).

## Engineering constraints

These hold everywhere; lint rules, build checks and tests enforce most of them.

- Node ≥ 22.16; TypeScript strict, ESM; exact dependency pins (no ranges). New third-party dependencies must carry a
  permissive licence (the release build checks the allowlist).
- No native modules.
- No global `fetch` and no `undici` for outbound connections: use `node:http`/`node:https`.
- `node:sqlite` only through `await import('node:sqlite')` (type imports are fine).
- `app.js` is CommonJS ES2017: no `??`, no `?.`, no top-level `await`.
- One `http.Server` per process.
- Source maps never go into the release zip; the zip stays under 15 MB.
- Respect the minimum database versions (MySQL 8.0, MariaDB 10.6, PostgreSQL 15, SQLite from Node). Shared SQL never
  uses `RETURNING`, `ON CONFLICT`, `ON DUPLICATE KEY` or JSON functions. No `sql.raw`; no Kysely `.stream()`.
- IDs are ULIDs in `CHAR(26)`; times are BIGINT epoch milliseconds; calendar dates are `CHAR(10)` (`YYYY-MM-DD`).
- DB migrations are append-only and must pass the N−1 test (`pnpm n-1`).
- No raw HTML: `dangerouslySetInnerHTML` and hono's `raw`/`html` are forbidden outside the sanitizing helpers.
- Dev keys (kids starting with `dev-`) never appear in a production build.

## Edition seam

The community edition enforces no licence, trial, branch limit or read-only mode, and it never writes the
`license_state` table (kept in the schema for compatibility). A commercial edition is a private fork that plugs into
these points only:

- `EditionService` (`packages/core/src/edition/edition.ts`): `check()`, `observeSignedTime()`, `invalidate()`;
  community answers `COMMUNITY_EDITION`, every release entitled.
- The route `mode` (`'read' | 'write' | 'system'`) of each `RouteDecl` and `services.editionGate(rc, decl)`, a no-op
  in community.
- `BANNER_PROVIDERS` and `ALL_ROUTES` in `apps/server`, the places an edition appends to.
- `editionRoutes` and `editionNav` in `apps/admin/src/edition/`.

**Do not add licence enforcement, feature gating or phone-home code to the community edition.**

## Safety rules

- Never commit a `*.key.json` outside `tools/keys/dev/` (`.gitignore` enforces it), nor any secret, token or `.env`.
- Never `npx` or `pnpm dlx` a tool that is not already in `node_modules/.bin`: it downloads unpinned code.
- SLiMS is clean-room: never copy SLiMS code or text; only interoperability facts (table and column names, file
  formats).
- Comments may cite ids such as `spec §…`, `Task N`, `D1d-xx` or `preflight …`: they point to the original private
  design records and are not in this repository. New code explains itself instead.
- Small Conventional Commits (`feat(catalog): …`, `fix(server): …`), each with `Signed-off-by:` (`git commit -s`).
