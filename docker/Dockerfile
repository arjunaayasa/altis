# ALTIS image (spec §9.1, §9.11; 1a Task 19, 1d Task 32).
#
# Built from an UNZIPPED RELEASE ZIP (altis-<version>.zip), never from the sources: compose.yml passes that folder as
# the named build context `release`; this folder (docker/) is the main context and its .dockerignore lets only
# entrypoint.sh through. So the image holds Node, the entrypoint and exactly the files of the zip (app.js and the
# signed bundled release): no .env, no .git, no source map, no node_modules, no native module.
#
#   ALTIS_RELEASE_DIR=/path/to/unzipped-release docker compose -f docker/compose.yml build
#   docker build --build-context release=/path/to/unzipped-release --tag <tag> docker     (the same, without compose)
#
# Runtime: user `node` (uid 1000), read-only root file system except the /data volume and the /tmp tmpfs
# (compose.yml); nothing is ever written under /app: COPY leaves the release owned by root, so `node` cannot change it,
# and runtime `docker` writes no app-folder marker (§7.7) and restarts by exiting (P14), never through
# <appRoot>/tmp/restart.txt. app.js listens on 3000 (ALTIS_PORT → PORT → config.json → 3000).
#
# The nightly image check (tools/release/smoke/docker-image-check.ts) proves these on the built image: no .env, .git or
# source map anywhere, a non-root USER, and nothing under /app that this user could change.
#
# Base image: node:24-bookworm-slim, pinned by the digest of the tag's multi-arch index (linux/amd64 and linux/arm64) as
# read from the registry on 2026-10-27, so a rebuild of an old release never picks up a moved tag. To move to a newer
# Node 24 patch or a Debian security update on purpose: `docker buildx imagetools inspect node:24-bookworm-slim`, copy
# its top-level `Digest:` here and the date above, and run the Docker smoke (`pnpm smoke --target docker`).
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ALTIS is AGPL-3.0-only: the image names its licence and where its source is (AGPL-3.0 section 13).
LABEL org.opencontainers.image.licenses="AGPL-3.0-only" org.opencontainers.image.source="https://github.com/arjunaayasa/altis"

ENV NODE_ENV=production ALTIS_DATA_DIR=/data ALTIS_RUNTIME=docker

COPY --chmod=0755 entrypoint.sh /usr/local/bin/altis-entrypoint
COPY --from=release . /app
# The volume starts as a copy of this folder, so it belongs to `node` from the first run.
RUN mkdir -p /data && chown node:node /data

USER node
WORKDIR /app
VOLUME /data
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/altis-entrypoint"]
CMD ["node", "/app/app.js"]
