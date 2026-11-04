#!/bin/sh
# ALTIS Docker entrypoint (spec §9.3, §9.11; Task 19). POSIX sh: the image's /bin/sh is dash.
#
# 1. Prepares DATA_DIR (/data): it must exist and be writable by this user (the image's `node`). When it is not, a
#    warning is printed and app.js still starts: its rescue page explains the problem (DATA_DIR_UNWRITABLE).
# 2. Copies the release bundled in the image (/app/bundled-release/<version>/) to /data/releases/<version>/ when that
#    folder is absent, so that `active` and `previous` always exist on the volume (spec §9.3). It only copies: the
#    release pointers (releases/current.json) belong to app.js and are never read or written here. The copy goes to a
#    temporary folder first and is renamed into place, so an interrupted copy never leaves a half-filled release; a
#    copy that fails is reported and skipped (app.js boots from the image either way).
#    ALTIS_RELEASE_SOURCE=image turns the copy off (spec §9.8: every release then comes from the image).
#    First (with ALTIS_RELEASE_SOURCE=image too), the temporary folders of copies a killed container left behind
#    (`.tmp-entrypoint-*`, whose EXIT trap never ran) are removed, as spec §9.3 wants every `.tmp-*` gone at boot (the
#    server's own boot sweep removes only its `.tmp-<version>-<op>` staging folders). Only folders unchanged for
#    STALE_COPY_MIN minutes go: a younger one may be the copy another container on this volume (a `docker compose run`)
#    is making right now.
#    Adoption (spec §9.3; 1d Task 27, packages/core/src/updates/adopt.ts) is the server's, not this script's: after
#    the first healthy boot of the bundled release, its `release.adopt` job verifies /data/releases/<version>/ as a
#    whole (signature and every file) and keeps this copy only when it verifies (otherwise it copies the release
#    itself), then flips that version's entries in current.json to `source: 'data'` and stores the release's keyset
#    documents. Until then the copy here is only a head start: nothing boots from it unverified, because app.js
#    verifies every release folder before it imports it.
# 3. Runs the command (by default `node /app/app.js`) in place of this shell.
set -eu

app_dir=/app
data_dir=${ALTIS_DATA_DIR:-/data}
# A copy takes seconds; a folder no copy has touched for this long is left over from a container that was killed.
STALE_COPY_MIN=60

say() {
  printf 'altis-entrypoint: %s\n' "$*" >&2
}

# Removes the `.tmp-entrypoint-*` folders of releases/ unchanged for STALE_COPY_MIN minutes (see 2. above). A
# failure is reported, never fatal: they are only disk space.
sweep_stale_copies() {
  if ! find "$data_dir/releases" -mindepth 1 -maxdepth 1 -type d -name '.tmp-entrypoint-*' -mmin +"$STALE_COPY_MIN" \
    -exec rm -rf {} +; then
    say "salinan sementara lama di $data_dir/releases tidak dapat dihapus / old temporary copies in $data_dir/releases could not be removed"
  fi
}

copy_release() {
  src=$1
  version=${src##*/}
  case $version in
    '' | .* | *[!0-9A-Za-z.+-]*)
      say "bundled-release/$version dilewati (bukan versi) / skipped (not a version)"
      return 0
      ;;
  esac
  if [ ! -f "$src/.complete" ]; then
    say "rilis terbundel $version tidak lengkap, tidak disalin / bundled release $version is incomplete, not copied"
    return 0
  fi
  dest=$data_dir/releases/$version
  if [ -e "$dest" ]; then
    return 0
  fi

  if ! tmp=$(mktemp -d "$data_dir/releases/.tmp-entrypoint-XXXXXX"); then
    say "rilis terbundel $version tidak disalin (mktemp gagal) / bundled release $version not copied (mktemp failed)"
    return 0
  fi
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if ! cp -R "$src/." "$tmp/"; then
    say "rilis terbundel $version gagal disalin / bundled release $version could not be copied"
  elif [ -e "$dest" ]; then
    : # another container copied it meanwhile: keep that one
  elif mv "$tmp" "$dest"; then
    if [ -e "$dest/${tmp##*/}" ]; then
      # $dest appeared between the test and the rename, so mv moved the copy into it: undo that.
      rm -rf "$dest/${tmp##*/}"
    else
      say "rilis terbundel $version disalin ke / bundled release $version copied to $dest"
    fi
  else
    say "rilis terbundel $version gagal dipindahkan / bundled release $version could not be moved into place"
  fi
  rm -rf "$tmp"
  trap - EXIT INT TERM
}

if [ -d "$data_dir" ] && [ -w "$data_dir" ]; then
  mkdir -p "$data_dir/releases"
  sweep_stale_copies
  if [ "${ALTIS_RELEASE_SOURCE:-}" != image ] && [ -d "$app_dir/bundled-release" ]; then
    for src in "$app_dir"/bundled-release/*; do
      if [ -d "$src" ]; then
        copy_release "$src"
      fi
    done
  fi
else
  say "$data_dir tidak ada atau tidak bisa ditulis oleh uid $(id -u); pasang volume yang dapat ditulis di $data_dir / $data_dir is missing or not writable by uid $(id -u); mount a writable volume at $data_dir"
fi

exec "$@"
