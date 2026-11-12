# shellcheck shell=bash
#
# The Hosted instance's half of deploy/install.sh: its inputs, where
# they are kept, and what they put in the backend's environment file. Sourced
# by install.sh when HOSTED_MODE=true; defines functions and constants and runs
# nothing. backend/test/deploy/hosted-install.spec.ts drives these functions
# directly, which is why they live in a file of their own.
#
# Every input is taken from the environment first and, failing that, from
# $HOSTED_INPUTS_FILE, which the first successful run writes. So the first
# install names them all and a re-run — the upgrade, docs/deploy.md §7 — names
# none: /etc/default/cloudgate-backend is rewritten from scratch on every run,
# and a re-run that forgot one would otherwise boot a backend the hosted boot
# check refuses. The file is read by name and never sourced (the rule
# `read_secret` in install.sh follows).

HOSTED_INPUTS_FILE=/etc/default/cloudgate-hosted

# The inputs a hosted install refuses to continue without, in the order the
# refusal names them, each with what it is.
HOSTED_REQUIRED_INPUTS=(
  CLOUDGATE_HOSTNAME
  SITE_URL
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  STARTER_PLAN_PRICE_ID
  BUSINESS_PLAN_PRICE_ID
  ADD_ON_PRICE_ID
  MAIL_FROM_ADDRESS
  RESEND_API_KEY
  TURNSTILE_SITE_KEY
  TURNSTILE_SECRET_KEY
  INSTANCE_OWNER_EMAIL
  INSTANCE_OWNER_FIRST_NAME
  INSTANCE_ORGANIZATION_NAME
  BACKUP_B2_KEY_ID
  BACKUP_B2_APPLICATION_KEY
  BACKUP_B2_BUCKET
  BACKUP_B2_FOLDER
  BACKUP_AGE_RECIPIENT
  BACKUP_ALERT_EMAIL
)
HOSTED_OPTIONAL_INPUTS=(
  INSTANCE_OWNER_LAST_NAME
  HETZNER_EUR_API_TOKEN
  HETZNER_USD_API_TOKEN
  BOUGHT_SERVER_REVERSE_DNS_DOMAIN
)

declare -A HOSTED_INPUT_SAYS=(
  [CLOUDGATE_HOSTNAME]="the one hostname the Hosted instance is served on, e.g. cloudgate.octabyte.app; its A record must point here"
  [SITE_URL]="the console's public address, https://<CLOUDGATE_HOSTNAME>"
  [STRIPE_SECRET_KEY]="the Stripe secret key"
  [STRIPE_WEBHOOK_SECRET]="the Stripe webhook endpoint's signing secret"
  [STARTER_PLAN_PRICE_ID]="the Starter plan's Stripe price id"
  [BUSINESS_PLAN_PRICE_ID]="the Business plan's Stripe price id"
  [ADD_ON_PRICE_ID]="the Add-on's Stripe price id"
  [MAIL_FROM_ADDRESS]="the Resend sender address"
  [RESEND_API_KEY]="the Resend API key"
  [TURNSTILE_SITE_KEY]="the Cloudflare Turnstile site key"
  [TURNSTILE_SECRET_KEY]="the Cloudflare Turnstile secret key"
  [INSTANCE_OWNER_EMAIL]="the first Octabyte staff account's email, owner of the Instance organization"
  [INSTANCE_OWNER_FIRST_NAME]="that account's first name"
  [INSTANCE_ORGANIZATION_NAME]="the Instance organization's name"
  [BACKUP_B2_KEY_ID]="the keyID of the Backblaze B2 application key the hourly backup uploads with"
  [BACKUP_B2_APPLICATION_KEY]="that B2 application key itself"
  [BACKUP_B2_BUCKET]="the B2 bucket the backups go to"
  [BACKUP_B2_FOLDER]="this instance's folder in that bucket, e.g. live or staging; never shared by two instances"
  [BACKUP_AGE_RECIPIENT]="the age public key (age1…) the backups are encrypted to; its identity stays in the vault, never on the box"
  [BACKUP_ALERT_EMAIL]="where the backup-staleness alert is mailed when no backup has succeeded for 3 hours"
)

# The inputs that are backend settings, written into
# /etc/default/cloudgate-backend under their own names. The rest are the
# installer's own: the hostname becomes the origins and the Traefik routing,
# the owner's become the create-instance-organization command's flags, and the
# BACKUP_* ones are read from $HOSTED_INPUTS_FILE by deploy/hosted-backup.sh,
# so the backend never holds the B2 key.
HOSTED_BACKEND_SETTINGS=(
  SITE_URL
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  STARTER_PLAN_PRICE_ID
  BUSINESS_PLAN_PRICE_ID
  ADD_ON_PRICE_ID
  MAIL_FROM_ADDRESS
  RESEND_API_KEY
  TURNSTILE_SITE_KEY
  TURNSTILE_SECRET_KEY
)

# The optional inputs that are backend settings: written only when given, so
# the backend tells "not set" from "set to nothing". Without both tokens the
# instance starts and offers no Buy a Server (ADR-0071); without the domain a
# Bought Server keeps the provider's reverse DNS.
HOSTED_OPTIONAL_BACKEND_SETTINGS=(
  HETZNER_EUR_API_TOKEN
  HETZNER_USD_API_TOKEN
  BOUGHT_SERVER_REVERSE_DNS_DOMAIN
)

# One stored input, by name: the last line wins, as in read_secret.
hosted_stored_input() {
  [ -r "$HOSTED_INPUTS_FILE" ] || return 0
  sed -n "s/^$1=//p" "$HOSTED_INPUTS_FILE" | tail -n 1
}

# Fills every input the environment left blank from $HOSTED_INPUTS_FILE.
hosted_load_inputs() {
  local name
  for name in "${HOSTED_REQUIRED_INPUTS[@]}" "${HOSTED_OPTIONAL_INPUTS[@]}"; do
    if [ -z "${!name:-}" ]; then
      printf -v "$name" '%s' "$(hosted_stored_input "$name")"
    fi
  done
}

# Refuses, naming every problem at once, while any required input is blank or
# any input cannot be written safely. Returns 1 having printed the list.
#
# A single quote is refused because the backend file quotes every value in
# single quotes: systemd reads that file, and install.sh sources it with
# `set -a; .` — so a `<` in "Cloudgate <hello@…>" unquoted would be a
# redirection, and a `$(` a command, run as root.
hosted_require_inputs() {
  local name value problems=()
  for name in "${HOSTED_REQUIRED_INPUTS[@]}"; do
    value="${!name:-}"
    if [ -z "${value//[[:space:]]/}" ]; then
      problems+=("$name (${HOSTED_INPUT_SAYS[$name]})")
    fi
  done
  for name in "${HOSTED_REQUIRED_INPUTS[@]}" "${HOSTED_OPTIONAL_INPUTS[@]}"; do
    value="${!name:-}"
    case "$value" in
      *"'"* | *$'\n'*) problems+=("$name must not contain a single quote or a line break") ;;
    esac
  done
  if [ -n "${CLOUDGATE_HOSTNAME:-}" ] &&
    ! [[ "$CLOUDGATE_HOSTNAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
    problems+=("CLOUDGATE_HOSTNAME must be a lower-case hostname, not \"$CLOUDGATE_HOSTNAME\"")
  fi
  if [ -n "${SITE_URL:-}" ] && [[ "$SITE_URL" != https://* ]]; then
    problems+=("SITE_URL must be an https:// address, not \"$SITE_URL\"")
  fi
  # A folder is one path segment, so one instance's retention can never reach
  # into another's (staging and live share a bucket).
  if [ -n "${BACKUP_B2_FOLDER:-}" ] && ! [[ "$BACKUP_B2_FOLDER" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    problems+=("BACKUP_B2_FOLDER must be one lower-case folder name such as live or staging, not \"$BACKUP_B2_FOLDER\"")
  fi
  if [ -n "${BACKUP_B2_BUCKET:-}" ] && ! [[ "$BACKUP_B2_BUCKET" =~ ^[A-Za-z0-9-]{6,63}$ ]]; then
    problems+=("BACKUP_B2_BUCKET must be a B2 bucket name (6-63 letters, digits and hyphens), not \"$BACKUP_B2_BUCKET\"")
  fi
  # An age X25519 recipient: "age1" and 58 bech32 characters. Anything else —
  # an identity (AGE-SECRET-KEY-1…) pasted by mistake above all — is refused,
  # since the identity must never be on the box the backups are taken from.
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] &&
    ! [[ "$BACKUP_AGE_RECIPIENT" =~ ^age1[02-9ac-hj-np-z]{58}$ ]]; then
    problems+=("BACKUP_AGE_RECIPIENT must be an age public key (age1…), never the identity")
  fi
  if [ -n "${BACKUP_ALERT_EMAIL:-}" ] && ! [[ "$BACKUP_ALERT_EMAIL" =~ ^[^[:space:]@\"]+@[^[:space:]@\"]+\.[^[:space:]@\"]+$ ]]; then
    problems+=("BACKUP_ALERT_EMAIL must be one email address, not \"$BACKUP_ALERT_EMAIL\"")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    {
      echo "HOSTED_MODE=true, but the hosted install cannot continue without:"
      printf '  - %s\n' "${problems[@]}"
      echo "Set them in the environment of this run. A later run reuses what this"
      echo "one was given, from $HOSTED_INPUTS_FILE."
    } >&2
    return 1
  fi
}

# Keeps this run's inputs for the next one, mode 0600: it holds the Stripe,
# Resend, Turnstile and B2 secrets, and the provider tokens of Bought Servers.
hosted_save_inputs() {
  local name tmp
  tmp="$(mktemp "$HOSTED_INPUTS_FILE.XXXXXX")"
  chmod 0600 "$tmp"
  {
    echo "# The Hosted instance's install.sh inputs. Read by name, never sourced."
    for name in "${HOSTED_REQUIRED_INPUTS[@]}" "${HOSTED_OPTIONAL_INPUTS[@]}"; do
      printf '%s=%s\n' "$name" "${!name:-}"
    done
  } > "$tmp"
  mv "$tmp" "$HOSTED_INPUTS_FILE"
}

# The lines appended to /etc/default/cloudgate-backend on the Hosted instance.
# $1 is the console's origin as Traefik's container reaches it, so a later
# Settings > Web server save resolves the same upstream as install.sh did.
hosted_backend_env() {
  local name
  echo "# The Hosted instance, written by install.sh from $HOSTED_INPUTS_FILE."
  echo "# Changing the mode is set-instance-mode's job, never an edit here."
  echo "HOSTED_MODE=true"
  echo "MAIL_PROVIDER=resend"
  for name in "${HOSTED_BACKEND_SETTINGS[@]}"; do
    printf "%s='%s'\n" "$name" "${!name}"
  done
  for name in "${HOSTED_OPTIONAL_BACKEND_SETTINGS[@]}"; do
    if [ -n "${!name:-}" ]; then
      printf "%s='%s'\n" "$name" "${!name}"
    fi
  done
  printf "CLOUDGATE_CONSOLE_URL='%s'\n" "$1"
  # install.sh's own input, the box's public address: on a cloud VM behind NAT
  # it is on no interface, and the backend refuses it as a Server address
  # (backend/src/servers/server-address-guard.ts). CLOUDGATE_CONSOLE_URL above
  # outranks it for the console's upstream, so it changes nothing else.
  if [ -n "${CLOUDGATE_PUBLIC_HOST:-}" ]; then
    printf "CLOUDGATE_PUBLIC_HOST='%s'\n" "$CLOUDGATE_PUBLIC_HOST"
  fi
}
