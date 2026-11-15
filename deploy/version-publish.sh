#!/usr/bin/env bash
#
# Puts a Cloudgate version (ADR-0082) on its tag's GitHub Release, run from
# the repository at that tag with gh signed in:
#
#     bash deploy/version-publish.sh v0.3.0 <dir>
#
# <dir> holds what deploy/version-tarball.sh wrote on each CPU: the
# linux-amd64 and linux-arm64 tarballs, each with its .sha256 (ADR-0088).
# .github/workflows/publish-version.yml runs it last, after every tarball has
# been smoke-booted. A version always has both tarballs: with any of the four
# files missing from <dir>, nothing is published.
#
#   no release for the tag     creates it, the four files attached and
#                              CHANGELOG.md's section for the version as its
#                              notes
#   a release with none        attaches all four (one made by hand on
#                              github.com)
#   a release with all four    leaves it as it is: a re-run never replaces a
#                              version someone may have installed
#   a release with some        refuses, replacing nothing; a person looks
#
# Exit 0 when the release has all four files, 1 otherwise.
#
# backend/test/deploy/version-publish.spec.ts runs it with gh shimmed.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

tag="${1:-}"
dir="${2:-}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  fail "A Cloudgate version tag is vX.Y.Z, not \"$tag\"."
version="${BASH_REMATCH[1]}"
files=()
for cpu in amd64 arm64; do
  files+=("cloudgate-$version-linux-$cpu.tar.gz" "cloudgate-$version-linux-$cpu.tar.gz.sha256")
done
paths=()
for file in "${files[@]}"; do
  [ -f "$dir/$file" ] ||
    fail "$dir/$file is not there; build it with deploy/version-tarball.sh on its CPU." \
      "A version is published with both tarballs or not at all, so nothing was published."
  paths+=("$dir/$file")
done

# "release not found" is the one failure that means there is none; any other
# is GitHub not answering, and publishes nothing.
view_error="$(mktemp)"
notes="$(mktemp)"
trap 'rm -f "$view_error" "$notes"' EXIT
if held="$(gh release view "$tag" --json assets --jq '.assets[].name' 2>"$view_error")"; then
  exists=true
elif grep -q 'release not found' "$view_error"; then
  exists=false
else
  cat "$view_error" >&2
  fail "Could not read the release for $tag, so nothing was published."
fi

if [ "$exists" = false ]; then
  # The version's section: from its "## " heading, which may carry a date, to
  # the next one (as deploy/hosted-release-gate.sh reads it).
  awk -v version="$version" '
    /^## / {
      if (inside) exit
      heading = substr($0, 4)
      sub(/^v/, "", heading)
      if (heading == version || index(heading, version " ") == 1) inside = 1
      next
    }
    inside { print }
  ' CHANGELOG.md > "$notes"
  [ -s "$notes" ] || echo "Cloudgate $version." > "$notes"
  gh release create "$tag" "${paths[@]}" \
    --verify-tag --title "Cloudgate $version" --notes-file "$notes"
  echo "Published $tag with its amd64 and arm64 tarballs ✅"
  exit 0
fi

has() { grep -qxF "$1" <<<"$held"; }
held_files=()
for file in "${files[@]}"; do
  if has "$file"; then held_files+=("$file"); fi
done
if [ "${#held_files[@]}" -eq "${#files[@]}" ]; then
  echo "$tag already has its tarballs and checksums; they are left as they are."
  exit 0
fi
if [ "${#held_files[@]}" -gt 0 ]; then
  fail "The release $tag already holds ${held_files[*]} but not all four files, and a published file is never replaced." \
    "Look at it on GitHub: delete what it holds of the four and run this again, or attach the others by hand."
fi
gh release upload "$tag" "${paths[@]}"
echo "Attached the amd64 and arm64 tarballs to the existing release $tag ✅"
