#!/usr/bin/env bash
#
# Puts a Cloudgate version (ADR-0082) on its tag's GitHub Release, run from
# the repository at that tag with gh signed in:
#
#     bash deploy/version-publish.sh v0.3.0 <dir>
#
# <dir> holds what deploy/version-tarball.sh wrote. .github/workflows/
# publish-version.yml runs it last, after the tarball has been smoke-booted.
#
#   no release for the tag     creates it, the tarball and checksum attached
#                              and CHANGELOG.md's section for the version as
#                              its notes
#   a release with neither     attaches both (one made by hand on github.com)
#   a release with both        leaves it as it is: a re-run never replaces a
#                              version someone may have installed
#   a release with one         refuses, replacing nothing; a person looks
#
# Exit 0 when the release has both files, 1 otherwise.
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
tarball="cloudgate-$version-linux-amd64.tar.gz"
checksum="$tarball.sha256"
for file in "$tarball" "$checksum"; do
  [ -f "$dir/$file" ] || fail "$dir/$file is not there; build it with deploy/version-tarball.sh."
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
  gh release create "$tag" "$dir/$tarball" "$dir/$checksum" \
    --verify-tag --title "Cloudgate $version" --notes-file "$notes"
  echo "Published $tag with $tarball ✅"
  exit 0
fi

has() { grep -qxF "$1" <<<"$held"; }
if has "$tarball" && has "$checksum"; then
  echo "$tag already has its tarball and checksum; they are left as they are."
  exit 0
fi
for file in "$tarball" "$checksum"; do
  if has "$file"; then
    fail "The release $tag already holds $file but not both files, and a published file is never replaced." \
      "Look at it on GitHub: delete what it holds of the two and run this again, or attach the other by hand."
  fi
done
gh release upload "$tag" "$dir/$tarball" "$dir/$checksum"
echo "Attached $tarball to the existing release $tag ✅"
