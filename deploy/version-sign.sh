#!/usr/bin/env bash
#
# Signs a Cloudgate version's two checksums (ADR-0087), run from the
# repository at its tag with the signing key in the environment:
#
#     VERSION_SIGNING_KEY="$(cat key)" bash deploy/version-sign.sh v0.3.0 <dir>
#
# <dir> holds what deploy/version-tarball.sh wrote on each CPU. Each
# cloudgate-X.Y.Z-linux-<cpu>.tar.gz.sha256 is signed with `ssh-keygen -Y sign`
# in the cloudgate-version namespace, the signature written beside it as
# .sha256.sig, which deploy/version-publish.sh then attaches with it. Each
# signature is checked, before anything is published, against the
# allowed-signers line root install.sh carries (VERSION_SIGNERS): a key that
# is not the one every box trusts would publish a version no box installs.
# A refused key leaves no signature behind.
#
# .github/workflows/publish-version.yml runs it with the VERSION_SIGNING_KEY
# Actions secret, an unencrypted OpenSSH private key.
# backend/test/deploy/version-publish.spec.ts runs it with keys it makes.

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
[ -n "${VERSION_SIGNING_KEY:-}" ] ||
  fail "VERSION_SIGNING_KEY is not set, so nothing was signed." \
    "It is the private half of the key whose public half root install.sh carries (ADR-0087)."
signers="$(sed -n "s/^VERSION_SIGNERS='\(.*\)'\$/\1/p" install.sh)"
[ -n "$signers" ] ||
  fail "Root install.sh has no VERSION_SIGNERS line, so nothing was signed."

checksums=()
for cpu in amd64 arm64; do
  checksum="$dir/cloudgate-$version-linux-$cpu.tar.gz.sha256"
  [ -f "$checksum" ] ||
    fail "$checksum is not there; build it with deploy/version-tarball.sh on its CPU. Nothing was signed."
  checksums+=("$checksum")
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && printf '%s\n' "$VERSION_SIGNING_KEY" >"$work/key")
printf '%s\n' "$signers" >"$work/allowed_signers"

for checksum in "${checksums[@]}"; do
  # ssh-keygen asks before replacing a signature; one left from an earlier
  # run is never the one to keep.
  rm -f "$checksum.sig"
  ssh-keygen -q -Y sign -f "$work/key" -n cloudgate-version "$checksum"
  if ! ssh-keygen -Y verify -f "$work/allowed_signers" -I cloudgate-version \
    -n cloudgate-version -s "$checksum.sig" <"$checksum" >/dev/null; then
    for signed in "${checksums[@]}"; do rm -f "$signed.sig"; done
    fail "The signature of $checksum does not verify against the key root install.sh trusts (VERSION_SIGNERS)." \
      "VERSION_SIGNING_KEY is not that key's private half, so nothing was signed and nothing will be published."
  fi
  echo "Signed $(basename "$checksum") ✅"
done
