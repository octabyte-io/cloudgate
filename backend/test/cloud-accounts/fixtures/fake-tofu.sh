#!/bin/bash
# A throwaway stand-in for `tofu`, for the runner's process-handling tests
# (seam 2a of the spec; test/cloud-accounts/tofu-runner.spec.ts). It never
# reaches AWS or a database. Each call is recorded under $FAKE_TOFU_RECORD as
# <n>.args, <n>.env and <n>.dir (a copy of the working folder), plus, on a
# Google run, <n>.credential-mode (the mode of the file
# $GOOGLE_APPLICATION_CREDENTIALS names, as `tofu` finds it), and
# $FAKE_TOFU_MODE picks how it behaves:
#   ok          every command succeeds
#   lock-held   plan fails with OpenTofu's lock error
#   creation-locked  plan fails as the pg backend's Lock does when another
#               state's workspace creation holds its shared creation key
#               past -lock-timeout (OpenTofu 1.13.1, remote-state/pg/client.go)
#   unreadable  plan, and show of the state, fail with OpenTofu's decryption error
#   creating-once  `workspace select -or-create` fails once as OpenTofu does
#               when the pg backend's creation key is held, then succeeds
#   creating-always  `workspace select -or-create` always fails so
#   creating-shared  `workspace select -or-create` takes one key every call
#               shares (a directory) for a moment, as the pg backend's
#               creation key is, and fails as creating-once does when another
#               call holds it; each call is counted in workspace-calls
#   no-workspace  `workspace list` names no state-1: no run made it yet
#   no-provider init fails as OpenTofu does when the mirror has no provider
#               matching the lock file
#   certificates  show of the state holds two Domain certificates
#   hang        apply waits until interrupted, then stops and exits 1
#   stubborn    apply ignores interrupts; its "provider" child sleeps too
#   slow        apply takes a moment, then succeeds
#   leaky       plan prints a value as OpenTofu masks it and as a provider's
#               error might quote it ($TF_VAR_variable_value_API_KEY), then
#               apply fails quoting it again
#   tag-race    the first apply creates a CodeBuild project, and reading it
#               back is refused as AWS refuses it before the project's tag
#               reaches IAM; the state then holds it tainted, and
#               every later apply succeeds
#   tag-race-twice    every apply fails as tag-race's first does
#   tag-race-grows    as tag-race, but the plan made after the failure also
#               creates a role the first plan did not
#   tag-race-unmade   the refused read is of a resource the apply modified,
#               not created
#   tag-race-mixed    the refused read comes with a second, unrelated error
# A tag-race mode's first plan creates aws_vpc.network and
# aws_codebuild_project.build; a plan after the failed apply changes nothing
# (tag-race-grows: creates aws_iam_role.extra).
# The runner hands `tofu` a clean environment, so the test sets both through
# a one-line wrapper that execs this script.
set -u
record="${FAKE_TOFU_RECORD:?}"
mode="${FAKE_TOFU_MODE:-ok}"

n=$(find "$record" -maxdepth 1 -name '*.args' | wc -l)
env -0 > "$record/$n.env"
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  stat -c %a "$GOOGLE_APPLICATION_CREDENTIALS" > "$record/$n.credential-mode" 2>/dev/null \
    || echo missing > "$record/$n.credential-mode"
fi
[ "$1" = version ] || cp -r . "$record/$n.dir"
# Last, so a test that sees <n>.args sees the whole call.
printf '%s\n' "$@" > "$record/$n.args.part"
mv "$record/$n.args.part" "$record/$n.args"

case "$1" in
  version)
    printf '{"terraform_version":"%s","platform":"linux_amd64","provider_selections":{}}\n' \
      "${FAKE_TOFU_VERSION:-1.13.1}"
    ;;
  init)
    if [ "$mode" = no-provider ]; then
      echo 'Error: Failed to query available provider packages' >&2
      echo 'provider registry.opentofu.org/hashicorp/google was not found in any of the' >&2
      echo 'search locations' >&2
      exit 1
    fi
    echo 'Initializing the backend...'
    echo 'OpenTofu has been successfully initialized!'
    ;;
  plan)
    case "$mode" in
      lock-held)
        echo 'Error: Error acquiring the state lock' >&2
        echo 'Error message: Workspace is already locked: state-1' >&2
        exit 1
        ;;
      creation-locked)
        echo 'Error: Error acquiring the state lock' >&2
        echo 'Error message: Cannot lock workspace; already locked for workspace creation: state-1' >&2
        exit 1
        ;;
      unreadable)
        echo 'Error: error loading state: decryption failed for all provided methods' >&2
        exit 1
        ;;
    esac
    if [ "$mode" = leaky ]; then
      echo '  ~ value = (sensitive value)'
      echo "  provider said: ${TF_VAR_variable_value_API_KEY:-}"
    fi
    for arg in "$@"; do
      case "$arg" in -out=*) echo 'an encrypted plan' > "${arg#-out=}" ;; esac
    done
    echo 'Plan: 1 to add, 0 to change, 0 to destroy.'
    ;;
  workspace)
    case "$mode:$*" in
      creating-once:*-or-create*|creating-always:*-or-create*)
        if [ "$mode" = creating-always ] || [ ! -e "$record/created" ]; then
          touch "$record/created"
          {
            echo 'Error: Error getting the state manager'
            echo
            echo 'Failed getting state manager for workspace state-1: failed to lock state in Postgres: Already locked for workspace creation: state-1'
          } >&2
          exit 1
        fi
        ;;
      creating-shared:*-or-create*)
        echo "$*" >> "$record/workspace-calls"
        if ! mkdir "$record/creation-key" 2>/dev/null; then
          {
            echo 'Error: Error getting the state manager'
            echo
            echo "Failed getting state manager for workspace $5: failed to lock state in Postgres: Already locked for workspace creation: $5"
          } >&2
          exit 1
        fi
        sleep 0.3
        rmdir "$record/creation-key"
        ;;
    esac
    # `workspace list`: the default and state-1, unless no run made state-1.
    if [ "${2:-}" = list ]; then
      echo '* default'
      [ "$mode" = no-workspace ] || echo '  state-1'
    fi
    ;;
  show)
    case "$*" in
      *cloudgate.tfplan*)
        case "$mode" in
          tag-race*)
            if [ ! -e "$record/raced" ]; then
              echo '{"format_version":"1.2","resource_changes":[{"address":"aws_vpc.network","change":{"actions":["create"]}},{"address":"aws_codebuild_project.build","change":{"actions":["create"]}}]}'
            elif [ "$mode" = tag-race-grows ]; then
              echo '{"format_version":"1.2","resource_changes":[{"address":"aws_vpc.network","change":{"actions":["no-op"]}},{"address":"aws_codebuild_project.build","change":{"actions":["no-op"]}},{"address":"aws_iam_role.extra","change":{"actions":["create"]}}]}'
            else
              echo '{"format_version":"1.2","resource_changes":[{"address":"aws_vpc.network","change":{"actions":["no-op"]}},{"address":"aws_codebuild_project.build","change":{"actions":["no-op"]}}]}'
            fi
            ;;
          *)
            echo '{"format_version":"1.2","variables":{"default_certificate_private_key":{"value":"PRIVATE-KEY"}},"resource_changes":[]}'
            ;;
        esac
        ;;
      *)
        # `show -json` of the state itself.
        case "$mode" in
          tag-race*)
            tainted=true
            [ -e "$record/untainted" ] && tainted=false
            printf '{"values":{"root_module":{"resources":[{"address":"aws_vpc.network","mode":"managed","type":"aws_vpc","name":"network"},{"address":"aws_codebuild_project.build","mode":"managed","type":"aws_codebuild_project","name":"build","tainted":%s}]}}}\n' "$tainted"
            exit 0
            ;;
        esac
        if [ "$mode" = unreadable ]; then
          echo 'Error: error loading state: decryption failed for all provided methods' >&2
          exit 1
        fi
        if [ "$mode" = certificates ]; then
          cat "$(dirname "$0")/states/static-domain-state.json"
        else
          cat "$(dirname "$0")/states/web-state.json"
        fi
        ;;
    esac
    ;;
  apply)
    case "$mode" in
      hang)
        trap 'echo "Interrupt received."; echo stopped > "$record/interrupted"; kill $! 2>/dev/null; exit 1' INT
        echo 'aws_vpc.network: Creating...'
        while true; do sleep 1 & wait $!; done
        ;;
      stubborn)
        trap 'echo "Interrupt received; still going."; echo ignored > "$record/interrupted"' INT
        sleep 600 &
        echo $! > "$record/provider.pid"
        echo $$ > "$record/tofu.pid"
        echo 'aws_vpc.network: Creating...'
        while true; do sleep 1 & wait $!; done
        ;;
      slow)
        sleep 0.5
        ;;
      leaky)
        echo "Error: ValidationException: value ${TF_VAR_variable_value_API_KEY:-} is invalid" >&2
        exit 1
        ;;
      tag-race*)
        if [ "$mode" = tag-race-twice ] || [ ! -e "$record/raced" ]; then
          touch "$record/raced"
          project='arn:aws:codebuild:us-east-1:111122223333:project/cloudgate-build-x'
          echo 'aws_vpc.network: Creating...'
          echo 'aws_vpc.network: Creation complete after 2s [id=vpc-1]'
          if [ "$mode" = tag-race-unmade ]; then
            echo 'aws_codebuild_project.build: Modifying...'
          else
            echo 'aws_codebuild_project.build: Creating...'
          fi
          {
            echo
            echo "Error: reading CodeBuild Project ($project): operation error CodeBuild: BatchGetProjects, https response error StatusCode: 400, RequestID: 5e1d, api error AccessDeniedException: User: arn:aws:sts::111122223333:assumed-role/cloudgate-deploy-x/cloudgate is not authorized to perform: codebuild:BatchGetProjects on resource: $project because no identity-based policy allows the codebuild:BatchGetProjects action"
            echo
            echo '  with aws_codebuild_project.build,'
            echo '  on main.tf.json line 1, in resource.aws_codebuild_project.build:'
            echo '   1: {"resource":{}}'
            echo
            if [ "$mode" = tag-race-mixed ]; then
              echo 'Error: creating EC2 Subnet: InvalidParameterValue: bad CIDR'
              echo
              echo '  with aws_subnet.public,'
            fi
          } >&2
          exit 1
        fi
        ;;
    esac
    echo 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.'
    ;;
  untaint)
    touch "$record/untainted"
    echo "Resource instance ${4:-} has been successfully untainted."
    ;;
  output)
    echo '{"vpc_id":{"sensitive":false,"type":"string","value":"vpc-1"}}'
    ;;
esac
