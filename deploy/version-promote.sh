#!/usr/bin/env bash
#
# Promotes a release candidate to the Cloudgate version it was cut for
# (ADR-0094), run from a checkout with every tag fetched and gh signed in:
#
#     bash deploy/version-promote.sh v0.3.0-rc.2
#
# .github/workflows/promote-release-candidate.yml runs it, then hands what it
# prints to publish-version.yml, which builds, boots, signs and publishes
# v0.3.0 and deploys it to the Hosted instance. The tests are not run again:
# the candidate's `E2E (release)` run passed on the very commit v0.3.0 names.
# It checks, before it tags anything, that
#
#   - the candidate's latest `E2E (release)` run on its tag passed, on the
#     commit the tag still names;
#   - the candidate's GitHub pre-release carries both its tarballs, their
#     checksums and both signatures, which only a publish run whose four boot
#     checks all passed puts there;
#   - v0.3.0 is not yet a tag, or is one on that same commit (a promotion run
#     again after its publish failed).
#
# and then creates the v0.3.0 tag on that commit through the GitHub API. A
# tag made with the workflow's GITHUB_TOKEN starts no workflow, so E2E does
# not run on it again.
#
# Prints, for $GITHUB_OUTPUT:
#
#     tag=v0.3.0
#     tested_sha=<the commit>
#
#   0  promoted (or already tagged on that commit)
#   1  refused, saying why; nothing is tagged
#
# backend/test/deploy/version-promote.spec.ts runs it with gh shimmed.

set -euo pipefail

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

candidate="${1:-}"
[[ "$candidate" =~ ^v(([0-9]+\.[0-9]+\.[0-9]+)-rc\.[1-9][0-9]*)$ ]] ||
  fail "A release candidate's tag is vX.Y.Z-rc.N, not \"$candidate\"."
candidate_version="${BASH_REMATCH[1]}"
tag="v${BASH_REMATCH[2]}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY names the repository, owner/name}"

sha="$(git rev-parse --verify --quiet "refs/tags/$candidate^{commit}")" ||
  fail "There is no tag $candidate, so there is nothing to promote."

# The newest E2E (release) run on the candidate's tag: a re-run after a red
# one replaces it, as GitHub lists the newest first.
run="$(gh run list --repo "$repository" --workflow e2e.yml --event push \
  --branch "$candidate" --limit 1 --json status,conclusion,headSha \
  --jq '.[] | "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.headSha)"')" ||
  fail "Could not ask GitHub for $candidate's E2E (release) run, so nothing was promoted."
status='' conclusion='' tested=''
read -r status conclusion tested <<<"$run" || true
[ -n "$status" ] ||
  fail "$candidate has no E2E (release) run, so nothing was promoted. Push the tag to start one."
[ "$status" = completed ] ||
  fail "$candidate's E2E (release) run has not finished (it is $status); promote it once it has passed."
[ "$conclusion" = success ] ||
  fail "$candidate's E2E (release) run did not pass (its conclusion is \"$conclusion\"), so nothing was promoted."
[ "$tested" = "$sha" ] ||
  fail "$candidate now names $sha, but its E2E (release) run tested $tested. A moved tag is not promoted untested."

assets="$(gh release view "$candidate" --repo "$repository" --json assets \
  --jq '.assets[].name')" ||
  fail "$candidate has no published pre-release, so it never passed its boot checks; nothing was promoted."
for cpu in amd64 arm64; do
  tarball="cloudgate-$candidate_version-linux-$cpu.tar.gz"
  for file in "$tarball" "$tarball.sha256" "$tarball.sha256.sig"; do
    grep -qxF "$file" <<<"$assets" ||
      fail "$candidate's pre-release has no $file, so its publish did not finish; nothing was promoted." \
        "Re-run its Publish Cloudgate version run, then promote it."
  done
done

if existing="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")"; then
  [ "$existing" = "$sha" ] ||
    fail "$tag already names $existing, not $sha, the commit $candidate tested; nothing was promoted."
  echo "$tag already names $sha; publishing it again." >&2
else
  gh api --method POST "repos/$repository/git/refs" \
    -f ref="refs/tags/$tag" -f sha="$sha" > /dev/null ||
    fail "GitHub did not create the tag $tag, so nothing was promoted."
  echo "Tagged $tag on $sha, the commit $candidate tested ✅" >&2
fi

echo "tag=$tag"
echo "tested_sha=$sha"
