#!/bin/bash
# A stand-in for `tofu` behind the Google client port's e2e fake
# (test/utils/fake-google-cloud-port.ts), so a Google plan read goes through
# the real shared runner — its run folder, its credential file — and replays
# a stored plan. It never reaches Google or a database. $FAKE_TOFU_DIR holds
# what the fake scripted, by the definition's kind (`network` when the run's
# main.tf.json makes a VPC, `postgres` when it makes a Cloud SQL instance,
# `redis` when it makes a Memorystore one, `bucket` when it makes a Cloud
# Storage bucket, `static` when it also makes a Cloud CDN backend bucket,
# `existing-redis` when it makes an Existing database's manual endpoints and
# no zone, `existing-postgres` when it makes an Existing database's
# private DNS zone, `existing-bucket` when it makes an HMAC key and
# no bucket, `worker` when it makes a Cloud Run worker pool,
# `cron` when it makes a Cloud Run job,
# `web-private` when its Cloud Run service's ingress is internal-only
# `destroy` when it makes nothing, else `web`; a network holding
# its Private web services' run.app zone is still `network`):
#   plan-<kind>.json  the `tofu show -json` the plan prints
#   plan-state-<state>.json  what a plan of that one state prints instead
#   plan-importing-<state>.json  what a plan of that state with `import`
#                     blocks prints (the fake writes it, per run)
#   plan-<kind>-targeted.json  what a plan limited by `-target` prints
#                     (the fake writes it from the above, per run)
#   fail-<kind>       if present, `plan` prints it to stderr and fails
#   outputs-<kind>.json  the `tofu output -json` an apply answers
#   fail-apply-<kind> if present, `apply` prints it to stderr and fails
#   state-<state>.json  what `show -json` of that state prints; its
#                     workspace is listed only when this or the next exists
#   unreadable-<state>  if present, `show` of that state fails as OpenTofu
#                     does when it cannot decrypt it
# and gets, for each plan, one line in `credentials`: the path
# $GOOGLE_APPLICATION_CREDENTIALS names and that file's mode as `tofu` finds
# it ("missing" if none), so a spec can see the run's proof was there while
# it ran and is gone after.
set -u
dir="${FAKE_TOFU_DIR:?}"

kind=web
[ -f main.tf.json ] && grep -q '"google_cloud_run_v2_worker_pool"' main.tf.json && kind=worker
[ -f main.tf.json ] && grep -q '"google_cloud_run_v2_job"' main.tf.json && kind=cron
[ -f main.tf.json ] && grep -q '"INGRESS_TRAFFIC_INTERNAL_ONLY"' main.tf.json && kind=web-private
[ -f main.tf.json ] && grep -q '"google_compute_forwarding_rule"' main.tf.json && ! grep -q '"google_compute_network"' main.tf.json && kind=existing-redis
[ -f main.tf.json ] && grep -q '"google_compute_network"' main.tf.json && kind=network
[ -f main.tf.json ] && grep -q '"google_sql_database_instance"' main.tf.json && kind=postgres
# A mysql on Cloud SQL: the same definition, a MySQL version.
[ -f main.tf.json ] && grep -q '"google_sql_database_instance"' main.tf.json && grep -q '"MYSQL_' main.tf.json && kind=mysql
[ -f main.tf.json ] && grep -q '"google_memorystore_instance"' main.tf.json && kind=redis
# The Hosted instance's network holds a cloud build's source bucket,
# and is still the network's.
[ -f main.tf.json ] && grep -q '"google_storage_bucket"' main.tf.json && ! grep -q '"google_compute_network"' main.tf.json && kind=bucket
[ -f main.tf.json ] && grep -q '"google_compute_backend_bucket"' main.tf.json && kind=static
[ -f main.tf.json ] && grep -q '"google_dns_managed_zone"' main.tf.json && ! grep -q '"google_compute_network"' main.tf.json && kind=existing-postgres
[ -f main.tf.json ] && grep -q '"google_storage_hmac_key"' main.tf.json && ! grep -q '"google_storage_bucket"' main.tf.json && kind=existing-bucket
[ -f main.tf.json ] && ! grep -q '"resource"' main.tf.json && kind=destroy

case "$1" in
  version)
    printf '{"terraform_version":"%s","platform":"linux_amd64","provider_selections":{}}\n' \
      "${FAKE_TOFU_VERSION:?}"
    ;;
  init)
    echo 'OpenTofu has been successfully initialized!'
    ;;
  workspace)
    # The state is the workspace of its id, the last word.
    [ "${2:-}" = select ] && echo "${@: -1}" > .fake-workspace
    if [ "${2:-}" = list ]; then
      echo '* default'
      for file in "$dir"/state-*.json "$dir"/unreadable-*; do
        [ -e "$file" ] || continue
        name=$(basename "$file" .json)
        echo "  ${name#*-}"
      done
    fi
    ;;
  plan)
    mode=$(stat -c %a "${GOOGLE_APPLICATION_CREDENTIALS:-}" 2>/dev/null || echo missing)
    echo "${GOOGLE_APPLICATION_CREDENTIALS:-} $mode" >> "$dir/credentials"
    if [ -f "$dir/fail-$kind" ]; then
      cat "$dir/fail-$kind" >&2
      exit 1
    fi
    plan="$dir/plan-$kind.json"
    state=$(cat .fake-workspace 2>/dev/null || true)
    if [ -n "$state" ]; then
      [ -f "$dir/plan-state-$state.json" ] && plan="$dir/plan-state-$state.json"
      [ -f "$dir/plan-importing-$state.json" ] && plan="$dir/plan-importing-$state.json"
    fi
    for arg in "$@"; do
      case "$arg" in -target=*) plan="$dir/plan-$kind-targeted.json" ;; esac
    done
    for arg in "$@"; do
      case "$arg" in -out=*) cp "$plan" "${arg#-out=}" ;; esac
    done
    echo 'Plan: replayed.'
    ;;
  show)
    # `show -json` of the saved plan names its file; of the state, nothing.
    if [ "${@: -1}" = cloudgate.tfplan ]; then
      cat cloudgate.tfplan
      exit 0
    fi
    state=$(cat .fake-workspace 2>/dev/null || true)
    if [ -f "$dir/unreadable-$state" ]; then
      echo 'Error: error loading state: decryption failed: cipher: message authentication failed' >&2
      exit 1
    fi
    cat "$dir/state-$state.json" 2>/dev/null || echo '{}'
    ;;
  apply)
    if [ -f "$dir/fail-apply-$kind" ]; then
      cat "$dir/fail-apply-$kind" >&2
      exit 1
    fi
    echo 'Apply complete! Resources: replayed.'
    ;;
  output)
    cat "$dir/outputs-$kind.json" 2>/dev/null || echo '{}'
    ;;
esac
