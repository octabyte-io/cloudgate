#!/usr/bin/env bash
#
# Builds the Cloudgate version tarball (ADR-0082) from the repository it is run
# in, and writes it and its checksum to <out-dir>:
#
#     bash deploy/version-tarball.sh <out-dir>
#
#     <out-dir>/cloudgate-<version>-linux-amd64.tar.gz
#     <out-dir>/cloudgate-<version>-linux-amd64.tar.gz.sha256   (sha256sum -c reads it)
#
# <version> is backend/package.json's, which deploy/version-gate.sh has already
# matched to the tag. .github/workflows/publish-version.yml runs it on
# ubuntu-24.04, the only platform the install accepts, because node-pty's
# pty.node is compiled here and runs only where it was compiled.
#
# The tarball's top level is what goes at /opt/cloudgate, with no directory of
# its own around it: unpack it into an empty directory.
#
#     VERSION                      the version, one line
#     LICENSE install.sh package.json pnpm-workspace.yaml pnpm-lock.yaml
#     node_modules/                production dependencies only, node-pty compiled
#     api-schemas/                 package.json, dist/, node_modules/
#     backend/                     package.json, dist/, assets/ (mail images),
#                                  drizzle/ (the migrations), drizzle.config.ts,
#                                  node_modules/ (.bin/drizzle-kit runs db:migrate)
#     frontend/                    package.json, server.mjs, server/, public/,
#                                  .next/ (no build cache), node_modules/,
#                                  next.config.ts and src/lib/config.ts, the one
#                                  file of source it imports
#     deploy/                      as in the repository: systemd units, Traefik
#                                  files, the OpenTofu lock file and schemas,
#                                  state-login.sql, the hosted scripts
#
# `next({ dev: false })` in server.mjs loads next.config.* from disk when the
# console starts; it does not read the copy the build left in .next. Without
# it the console ran on Next's defaults, a 30 s proxy timeout and a 10 MB
# request body (#30), so the config ships, with the file it imports
# (src/lib/config.ts, which imports server/api-origin.mjs), and Next's own
# SWC, a production dependency, transpiles it at start. Shipping those two
# rather than a compiled next.config.mjs keeps one config, not a second,
# generated one that can drift from it.
#
# No other source, and no tests, env files, CLI or docs. The console is built with
# BACKEND_INTERNAL_ORIGIN set to the install's loopback API; the API's public
# address is read when the console starts, so one tarball serves every box.
#
# It replaces every node_modules in the tree with production ones, so run it in
# a checkout made for it, never a working copy.
#
#   0  built
#   1  refused: node-pty did not compile, or production node_modules cannot run
#      the migrations. Nothing is written to <out-dir>.
#
# backend/test/deploy/version-tarball.spec.ts runs it with pnpm shimmed.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

log() { printf '\n==> %s\n' "$*"; }

out="${1:-}"
[ -n "$out" ] || fail "Usage: bash deploy/version-tarball.sh <out-dir>"

version="$(node -p "require('./backend/package.json').version")"
name="cloudgate-$version-linux-amd64"
# Where the install's console reaches its backend (deploy/install.sh writes the
# same value): fixed into the console's rewrites by its build.
BACKEND_INTERNAL_ORIGIN=http://127.0.0.1:4000
# `nest build` type-checks the whole backend, and V8's default heap is not
# enough for it.
BUILD_HEAP=--max-old-space-size=4096
# Set only where it is meant: a NODE_ENV=production install skips the
# devDependencies the builds need.
unset NODE_ENV

log "pnpm install"
pnpm install --frozen-lockfile

log "Backend build"
NODE_ENV=production NODE_OPTIONS="$BUILD_HEAP" pnpm --filter backend build

log "Console build"
NODE_ENV=production NODE_OPTIONS="$BUILD_HEAP" \
  BACKEND_INTERNAL_ORIGIN="$BACKEND_INTERNAL_ORIGIN" \
  pnpm --filter frontend build

# Afresh rather than pruned: pnpm's --prod over a full install leaves the
# devDependencies' packages in node_modules/.pnpm. --ignore-scripts because
# api-schemas' `prepare` needs TypeScript, a devDependency, and its dist/ is
# already built; node-pty's compile, the one build script the backend needs at
# runtime, is run on its own after: `-r`, because it is backend's dependency
# and a bare `pnpm rebuild` at the root looks only at the root's.
log "Production node_modules"
rm -rf node_modules ./*/node_modules
pnpm install --frozen-lockfile --prod --ignore-scripts
pnpm rebuild -r node-pty

# node-pty ships darwin and win32 prebuilds and no Linux one, so only a
# compiled build/Release/pty.node means /terminal and the container terminals
# work. drizzle-kit is what `db:migrate` runs.
find node_modules/.pnpm -path '*/node-pty/build/Release/pty.node' | grep -q . ||
  fail "node-pty did not compile pty.node, so the terminals would not work. Nothing was packed."
[ -e backend/node_modules/.bin/drizzle-kit ] ||
  fail "drizzle-kit is not in production node_modules, so db:migrate could not run. Nothing was packed."

contents=(
  LICENSE install.sh package.json pnpm-workspace.yaml pnpm-lock.yaml
  node_modules
  api-schemas/package.json api-schemas/dist
  backend/package.json backend/dist backend/assets backend/drizzle backend/drizzle.config.ts
  frontend/package.json frontend/server.mjs frontend/server frontend/public frontend/.next
  frontend/next.config.ts frontend/src/lib/config.ts
  deploy
)
for package in api-schemas backend frontend; do
  if [ -d "$package/node_modules" ]; then contents+=("$package/node_modules"); fi
done

log "Packing $name.tar.gz"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
printf '%s\n' "$version" > "$stage/VERSION"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
tar -czf "$stage/$name.tar.gz" \
  --exclude=frontend/.next/cache \
  --exclude='frontend/server/*.test.mjs' \
  -C "$stage" VERSION \
  -C "$PWD" "${contents[@]}"

cd "$stage"
if command -v sha256sum >/dev/null; then
  sha256sum "$name.tar.gz" > "$name.tar.gz.sha256"
else
  shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256"
fi
mv "$name.tar.gz" "$name.tar.gz.sha256" "$out/"
echo "$out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1)) ✅"
