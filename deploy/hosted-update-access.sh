#!/usr/bin/env bash
#
# Lets .github/workflows/deploy-hosted.yml upgrade the Hosted instance, once,
# as root on the box:
#
#     bash /opt/cloudgate/deploy/hosted-update-access.sh 'ssh-ed25519 AAAA… deploy'
#
# The argument is the public half of the key whose private half is the
# HOSTED_SSH_PRIVATE_KEY secret of the GitHub environment `hosted`. Running it
# again with another key replaces the old one; that is how the key is rotated.
#
# It makes the cloudgate-deploy user, which has no password and whose one key
# can run only /usr/local/sbin/cloudgate-update (deploy/hosted-update.sh), with
# no shell, pty or forwarding (`restrict`). Its authorized_keys is root's, so
# the user cannot change its own forced command. One sudoers line lets it run
# that root-owned updater as root, and nothing else.
#
# It ends by printing the line for HOSTED_SSH_KNOWN_HOSTS.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTED_INPUTS_FILE=/etc/default/cloudgate-hosted
BACKEND_ENV_FILE=/etc/default/cloudgate-backend
DEPLOY_USER=cloudgate-deploy
DEPLOY_HOME=/var/lib/cloudgate-deploy
UPDATER=/usr/local/sbin/cloudgate-update
SUDOERS_FILE=/etc/sudoers.d/cloudgate-deploy

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "Run it as root."
[ -f "$HOSTED_INPUTS_FILE" ] ||
  fail "$HOSTED_INPUTS_FILE is missing: run the hosted install first (docs/deploy.md §11)."

key="${1:-}"
# One ed25519 public key, optionally with a comment: no quotes, options or line
# breaks can reach the authorized_keys line below.
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [A-Za-z0-9@._-]+)?$ ]] ||
  fail "Give the deploy key's public half, one line: 'ssh-ed25519 AAAA… comment'." \
    "Make the pair with: ssh-keygen -t ed25519 -f cloudgate-deploy -N '' -C cloudgate-deploy"

install -m 0755 -o root -g root "$REPO_ROOT/deploy/hosted-update.sh" "$UPDATER"

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DEPLOY_HOME" --create-home --shell /bin/sh "$DEPLOY_USER"
fi

install -d -m 0755 -o root -g root "$DEPLOY_HOME/.ssh"
tmp="$(mktemp "$DEPLOY_HOME/.ssh/authorized_keys.XXXXXX")"
printf 'restrict,command="%s" %s\n' "$UPDATER" "$key" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$DEPLOY_HOME/.ssh/authorized_keys"

tmp="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$UPDATER" > "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; fail "visudo refused the sudoers line; nothing was changed in /etc/sudoers.d."; }
install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
rm -f "$tmp"

host="$(sed -n "s/^CLOUDGATE_PUBLIC_HOST='\(.*\)'\$/\1/p" "$BACKEND_ENV_FILE" 2>/dev/null | tail -n 1)"
host="${host:-<this box address>}"
echo "$DEPLOY_USER can now run $UPDATER and nothing else ✅"
echo
echo "HOSTED_SSH_HOST:        $host"
echo "HOSTED_SSH_KNOWN_HOSTS: $host $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
