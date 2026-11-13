#!/usr/bin/env bash
#
# Says whether a tag may be published as a Cloudgate version (ADR-0082), run
# from the repository checked out at that tag:
#
#     E2E_CONCLUSION=success TESTED_SHA=<sha> bash deploy/version-gate.sh v0.3.0
#
# .github/workflows/publish-version.yml runs it before it builds anything,
# with the conclusion and head commit of the `E2E (release)` run that started
# it. The tag checks are deploy-hosted.yml's and deploy/hosted-release-gate.sh's.
#
#   0  publish it: E2E passed, the tag still names the commit E2E tested and
#      the one checked out here, and it is backend/package.json's version.
#   1  refused, saying why: the tag is not vX.Y.Z, E2E did not pass, the tag
#      moved after E2E tested it, or the Instance would report another version.
#
# backend/test/deploy/version-gate.spec.ts runs it against a scratch
# repository.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

tag="${1:-}"
[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] ||
  fail "A Cloudgate version tag is vX.Y.Z, not \"$tag\"."
version="${BASH_REMATCH[1]}"

[ "${E2E_CONCLUSION:-}" = success ] ||
  fail "E2E (release) did not pass for $tag (its conclusion is \"${E2E_CONCLUSION:-}\"), so nothing is published."

tagged="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")" ||
  fail "There is no tag $tag here."
[ "$tagged" = "${TESTED_SHA:-}" ] ||
  fail "$tag now names $tagged, but E2E tested ${TESTED_SHA:-nothing}. A moved tag is not published untested."
[ "$(git rev-parse HEAD)" = "$tagged" ] ||
  fail "This tree is $(git rev-parse HEAD), so it is not checked out at $tag ($tagged)."

package_version="$(node -p "require('./backend/package.json').version")"
[ "$package_version" = "$version" ] ||
  fail "$tag is not backend/package.json's version ($package_version); the Instance would report $package_version."

echo "$tag may be published: E2E passed on $tagged ✅"
