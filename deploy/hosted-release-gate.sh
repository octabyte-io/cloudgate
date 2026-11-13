#!/usr/bin/env bash
#
# Says whether a server release may reach the Hosted instance without a person,
# run from the repository at that release's tag:
#
#     bash deploy/hosted-release-gate.sh v0.3.0
#
# .github/workflows/deploy-hosted.yml runs it before it connects to the box.
#
#   0  deploy it: the tag is backend/package.json's version, and every
#      "**What to do on upgrade**:" line in CHANGELOG.md's section for that
#      version says "nothing." (or the section has none).
#   3  a person first: some upgrade line asks for something, such as
#      subscribing the Stripe webhook to a new event, or reads "nothing, if …".
#      Those lines are printed. Do them, then deploy with the workflow's
#      manual_steps_done input.
#   1  refused: the tag is not vX.Y.Z, it disagrees with backend/package.json,
#      or CHANGELOG.md has no "## <version>" (or "## v<version>") section.
#
# backend/test/deploy/hosted-release-gate.spec.ts runs it against a scratch
# repository.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

tag="${1:-}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  fail "A server version tag is vX.Y.Z, not \"$tag\"."
version="${BASH_REMATCH[1]}"

package_version="$(node -p "require('./backend/package.json').version")"
[ "$package_version" = "$version" ] ||
  fail "$tag is not backend/package.json's version ($package_version); the Instance would report $package_version."

# The version's section: from its "## " heading, which may carry a date after
# the version, to the next "## " heading.
section="$(awk -v version="$version" '
  /^## / {
    if (inside) exit
    heading = substr($0, 4)
    sub(/^v/, "", heading)
    if (heading == version || index(heading, version " ") == 1) { inside = 1; found = 1 }
    next
  }
  inside { print }
  END { if (!found) exit 2 }
' CHANGELOG.md)" || fail "CHANGELOG.md has no \"## $version\" section, so what the upgrade asks for cannot be read."

steps="$(printf '%s\n' "$section" | grep -F '**What to do on upgrade**' || true)"
asks="$(printf '%s\n' "$steps" | grep -v -E '^\*\*What to do on upgrade\*\*: nothing\.( |$)' | grep -v '^$' || true)"

if [ -n "$asks" ]; then
  echo "$tag asks for something on upgrade; a person does it first:"
  printf '%s\n' "$asks"
  exit 3
fi
echo "$tag asks for nothing on upgrade ✅"
