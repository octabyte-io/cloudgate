#!/usr/bin/env bash
# The builder image's smoke check: inside the Cloudgate builder image,
# build a sample app of every build kind a hosted cloud build runs, then run
# each built image once and require the line its app prints.
#
#   Dockerfile  smoke/dockerfile   docker buildx build
#   buildpacks  smoke/node         the builder's run image pulled first, then
#                                   pack build, on heroku/builder:24 (the Heroku
#                                   builder's default; Paketo is the same pack),
#                                   as heroku.strategy.ts
#   Nixpacks    smoke/node         nixpacks build
#   Railpack    smoke/node         railpack prepare, then buildx through the
#                                   railpack frontend, as railpack.strategy.ts
#
# .github/workflows/builder-image.yml runs it in the image with this directory
# mounted at /smoke, once with the runner's docker socket mounted (the Cloud
# Build shape) and once privileged with `cloudgate-start-dockerd` first (the
# CodeBuild shape). It needs nothing from the runner but a daemon. The
# runner's daemon uses the containerd image store, as the image's own does, so
# both shapes build on it.
#
# Each build function chains its steps with `&&` rather than leaning on
# `set -e`, which bash switches off inside a function called as an `if`
# condition, as the loop below calls them.
#
# The apps are copied to a scratch directory first: nixpacks and railpack
# write their plans into the app's directory, and /smoke is mounted read-only.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$here/dockerfile" "$here/node" "$work/"

marker=cloudgate-smoke-ok
failed=()

# Runs the image a kind built and requires the marker in its output.
expect_runs() {
  local kind=$1 image=$2 output
  if ! output=$(docker run --rm "$image" 2>&1); then
    echo "❌ $kind: the built image $image did not run:" >&2
    echo "$output" >&2
    return 1
  fi
  if ! grep -qx "$marker" <<<"$output"; then
    echo "❌ $kind: the built image $image ran but did not print '$marker':" >&2
    echo "$output" >&2
    return 1
  fi
  echo "✅ $kind: built and ran."
}

build_dockerfile() {
  docker buildx build --load -t cg-smoke-dockerfile "$work/dockerfile" &&
    expect_runs Dockerfile cg-smoke-dockerfile
}

# The run-image pull is heroku.strategy.ts's, word for word
# (packRunImagePull in backend/src/builders/pack-install.ts; a unit test keeps
# the two equal), so this proves what a hosted build does on a daemon with the
# containerd image store.
build_buildpacks() {
  {
echo "> Pulling the run image of" heroku/builder:24 "before the builder itself, so the daemon keeps every layer pack exports on…" ;
pack builder inspect heroku/builder:24 --output json </dev/null 2>/dev/null | sed -n '/"run_images"/,/]/s/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1 | xargs -r docker pull || true
  } &&
    pack build cg-smoke-buildpacks --path "$work/node" --builder heroku/builder:24 &&
    expect_runs buildpacks cg-smoke-buildpacks
}

build_nixpacks() {
  nixpacks build "$work/node" --name cg-smoke-nixpacks &&
    expect_runs Nixpacks cg-smoke-nixpacks
}

build_railpack() {
  local builder="cg-smoke-railpack-$$" status=0
  docker buildx create --name "$builder" --driver docker-container >/dev/null || return
  {
    railpack prepare "$work/node" \
      --plan-out "$work/node/railpack-plan.json" \
      --info-out "$work/node/railpack-info.json" &&
      docker buildx build --builder "$builder" \
        --build-arg "BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}" \
        -f "$work/node/railpack-plan.json" \
        --output type=docker,name=cg-smoke-railpack \
        "$work/node"
  } || status=$?
  docker buildx rm "$builder" >/dev/null || true
  [ "$status" -eq 0 ] || return "$status"
  expect_runs Railpack cg-smoke-railpack
}

echo "Builder image tools: $(docker buildx version | head -n1); pack $(pack --version); $(nixpacks --version); railpack $(railpack --version)"

for kind in dockerfile buildpacks nixpacks railpack; do
  echo "::group::$kind"
  if ! "build_$kind"; then
    failed+=("$kind")
    echo "❌ $kind: the build failed (its output is above)." >&2
  fi
  echo "::endgroup::"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "❌ The builder image could not build: ${failed[*]}." >&2
  exit 1
fi
echo "✅ The builder image built and ran a sample app of every kind."
