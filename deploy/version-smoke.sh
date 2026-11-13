#!/usr/bin/env bash
#
# Boots a Cloudgate version tarball the way an install runs it, before
# .github/workflows/publish-version.yml publishes it (ADR-0082):
#
#     DATABASE_URL=postgresql://…/empty bash deploy/version-smoke.sh \
#       <dir>/cloudgate-<version>-linux-amd64.tar.gz <empty-dir>
#
# It checks the tarball against its .sha256, unpacks it into <empty-dir>,
# migrates the empty database at DATABASE_URL with the tarball's own
# drizzle-kit, starts the backend on :4000 and the console on :3000 with node
# alone (no pnpm, no build tools, nothing from the repository), and passes
# when the backend's /settings/about reports VERSION, the console serves a
# page, and the console's rewrite reaches the backend over loopback. Both
# processes are stopped when it ends; their logs are printed if it fails.
#
# It needs only node on PATH, curl, and ports 3000 and 4000 free.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

log() { printf '\n==> %s\n' "$*"; }

tarball="${1:-}"
into="${2:-}"
[ -f "$tarball" ] && [ -n "$into" ] ||
  fail "Usage: DATABASE_URL=… bash deploy/version-smoke.sh <tarball> <empty-dir>"
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL must name an empty Postgres database."

log "Checksum"
(cd "$(dirname "$tarball")" && sha256sum -c "$(basename "$tarball").sha256")

log "Unpack"
mkdir -p "$into"
[ -z "$(ls -A "$into")" ] || fail "$into is not empty."
into="$(cd "$into" && pwd)"
tar -xzf "$tarball" -C "$into"
version="$(cat "$into/VERSION")"
echo "VERSION $version"

log "Migrate an empty database"
(cd "$into/backend" && node_modules/.bin/drizzle-kit migrate)

pids=()
stop() {
  status=$?
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    for name in backend console; do
      if [ -f "$into/$name.log" ]; then
        echo "--- $name log ---"
        tail -n 80 "$into/$name.log"
      fi
    done
  fi
}
trap stop EXIT

secret() { node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"; }

# What deploy/install.sh writes to /etc/default/cloudgate-backend, minus what
# only a real host has, and with the platform directory kept off /etc.
log "Start the backend"
mkdir -p "$into/platform"
(
  cd "$into/backend"
  exec env NODE_ENV=production PORT=4000 \
    DATABASE_URL="$DATABASE_URL" \
    APP_ENCRYPTION_SECRET="$(secret)" BETTER_AUTH_SECRET="$(secret)" \
    BETTER_AUTH_URL=http://127.0.0.1:3000 \
    CLOUDGATE_DIRECTORY="$into/platform" TRUST_PROXY=loopback \
    node dist/main > "$into/backend.log" 2>&1
) &
pids+=($!)

log "Start the console"
(
  cd "$into/frontend"
  exec env NODE_ENV=production PORT=3000 CLOUDGATE_API_URL=http://127.0.0.1:4000 \
    node server.mjs > "$into/console.log" 2>&1
) &
pids+=($!)

# Waits up to two minutes for `url` to answer with one of `codes`; prints the body.
answer() {
  local url="$1" codes="$2" code
  for _ in $(seq 1 120); do
    code="$(curl -s -o "$into/answer" -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ " $codes " == *" $code "* ]]; then
      cat "$into/answer"
      return 0
    fi
    sleep 1
  done
  fail "$url did not answer with $codes (last: ${code:-nothing})."
}

about_version() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'; }

log "The backend answers /settings/about"
reported="$(answer http://127.0.0.1:4000/settings/about 200 | about_version)"
[ "$reported" = "$version" ] || fail "The backend reports version $reported, not $version."
echo "backend: $reported"

log "The console serves a page"
answer http://127.0.0.1:3000/ "200 307 308" > /dev/null
echo "console: answered /"

log "The console reaches the backend over loopback"
proxied="$(answer http://127.0.0.1:3000/backend/settings/about 200 | about_version)"
[ "$proxied" = "$version" ] || fail "The console's /backend/settings/about reports $proxied, not $version."
echo "console → backend: $proxied"

echo
echo "$(basename "$tarball") unpacks, migrates and boots ✅"
