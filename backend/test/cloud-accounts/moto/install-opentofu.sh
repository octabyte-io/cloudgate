#!/usr/bin/env bash
# The release lanes' OpenTofu and providers: the same release
# artefacts deploy/install.sh installs, checked the same way, into a folder of
# the caller's choosing rather than /usr/local/share/cloudgate.
#
# The versions and checksums are read from where they are pinned — the
# OPENTOFU_* defaults in deploy/install.sh and deploy/opentofu/.terraform.lock.hcl
# — and never restated here, so a lane always runs what an install runs.
#
#   backend/test/cloud-accounts/moto/install-opentofu.sh <dir> [<provider>...]
#
# installs OpenTofu and each named `hashicorp/` provider — `aws` when none is
# named (the moto lane), `google` for the Google validate lane —
# and prints the two variables the lanes read, ready for `>> "$GITHUB_ENV"` or
# `eval`: OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR.
set -euo pipefail

dir="${1:?usage: install-opentofu.sh <dir> [<provider>...]}"
shift
providers=("$@")
if [ "${#providers[@]}" -eq 0 ]; then
  providers=(aws)
fi
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
install_sh="$repo/deploy/install.sh"
lock="$repo/deploy/opentofu/.terraform.lock.hcl"

# `OPENTOFU_VERSION="${OPENTOFU_VERSION:-1.13.1}"` → 1.13.1
pinned() { sed -n "s/^$1=\"\${$1:-\(.*\)}\"\$/\1/p" "$install_sh"; }
tofu_version="$(pinned OPENTOFU_VERSION)"
tofu_sha256="$(pinned OPENTOFU_SHA256)"
if [ -z "$tofu_version" ] || [ -z "$tofu_sha256" ]; then
  echo "Could not read the OpenTofu pins from $install_sh." >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ]; then
  echo "The pins are the linux_amd64 builds; this host is $(uname -m)." >&2
  exit 1
fi

mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
binary="$dir/bin/tofu"
mirror="$dir/providers"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ "$("$binary" version -json 2>/dev/null | jq -r .terraform_version 2>/dev/null || true)" != "$tofu_version" ]; then
  tarball="tofu_${tofu_version}_linux_amd64.tar.gz"
  curl -fsSL -o "$tmp/$tarball" \
    "https://github.com/opentofu/opentofu/releases/download/v${tofu_version}/${tarball}"
  echo "${tofu_sha256}  $tmp/$tarball" | sha256sum -c - >&2
  mkdir "$tmp/unpacked"
  tar -xzf "$tmp/$tarball" -C "$tmp/unpacked" --no-same-owner
  install -D -m 0755 "$tmp/unpacked/tofu" "$binary"
fi

for type in "${providers[@]}"; do
  # The provider's block of the lock file alone: its version and checksums.
  block="$(awk -v open="provider \"registry.opentofu.org/hashicorp/$type\" {" \
    '$0 == open { on = 1 } on { print } on && $0 == "}" { exit }' "$lock")"
  version="$(sed -n 's/^  version     = "\(.*\)"$/\1/p' <<<"$block")"
  if [ -z "$version" ]; then
    echo "$lock pins no hashicorp/$type." >&2
    exit 1
  fi
  provider_dir="$mirror/registry.opentofu.org/hashicorp/$type/$version/linux_amd64"
  if [ -x "$provider_dir/terraform-provider-$type" ]; then
    continue
  fi
  zip="terraform-provider-${type}_${version}_linux_amd64.zip"
  curl -fsSL -o "$tmp/$zip" \
    "https://github.com/opentofu/terraform-provider-${type}/releases/download/v${version}/${zip}"
  sum="$(sha256sum "$tmp/$zip" | cut -d' ' -f1)"
  if ! grep -qx "    \"zh:${sum}\"," <<<"$block"; then
    echo "$zip (sha256 $sum) is not a checksum $lock pins." >&2
    exit 1
  fi
  echo "$zip: OK (deploy/opentofu/.terraform.lock.hcl)" >&2
  rm -rf "$provider_dir"
  mkdir -p "$provider_dir"
  unzip -q "$tmp/$zip" -d "$provider_dir"
  rm -f "$tmp/$zip"
done

echo "OPENTOFU_BINARY=$binary"
echo "OPENTOFU_PROVIDER_MIRROR=$mirror"
