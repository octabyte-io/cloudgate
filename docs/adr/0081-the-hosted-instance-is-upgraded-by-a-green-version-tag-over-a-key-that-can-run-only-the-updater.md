# The Hosted instance is upgraded by a green version tag, over a key that can run only the updater

Status: accepted.

The Hosted instance is one box, and its upgrade is the one-command install run again with `HOSTED_MODE=true` (docs/deploy.md §7). Someone had to SSH in and run it after every server version. We want each version to reach the box without that, and without the box ever running code that was not tested or a version that needs a person first.

**A green `E2E (release)` run on a pushed `v*` tag starts the upgrade.** `.github/workflows/deploy-hosted.yml` runs on that workflow's `workflow_run`, only for a successful run on a pushed tag, and refuses a tag that has moved since the commit E2E tested. A red run deploys nothing. The E2E run stays a record of the version as before; what is new is that a green one is also the gate for the Hosted instance.

**A version that asks for something on upgrade waits for a person.** `deploy/hosted-release-gate.sh` reads the version's `CHANGELOG.md` section and lets the upgrade go on only when every "**What to do on upgrade**" line there reads "nothing." Anything else, "nothing, if …" included, stops the run and names the lines. The person does them and runs the workflow by hand with the tag and `manual_steps_done`. A tag that is not `backend/package.json`'s version, or a version with no section, is refused.

**GitHub holds a key that can run one command, never a shell.** The key logs in as `cloudgate-deploy`, which has no password. Its `authorized_keys` line is `restrict,command="/usr/local/sbin/cloudgate-update"`, and that file is root's, so the user cannot change it. One sudoers line lets that user run the root-owned updater and nothing else. The updater takes one argument, a `vX.Y.Z` tag, from `SSH_ORIGINAL_COMMAND`, and refuses anything else before it reaches sudo. It deploys only a tag whose commit is on `origin/main`.

**No instance secret leaves the box.** The Stripe, Resend, Turnstile and B2 inputs stay in `/etc/default/cloudgate-hosted`, which every install re-reads. GitHub holds only the SSH key, the box's host key and the box's address, on an environment named `hosted`.

**The upgrade runs in its own unit, not under SSH.** The updater starts `cloudgate-update.service` with `systemd-run`, follows its journal and returns its exit status. A dropped connection cannot cut an install off between its migrations and its builds, and a second upgrade while one runs is refused because the unit exists. The unit takes a B2 backup first and installs nothing if the backup fails.

## Considered Options

- **A timer on the box that polls for a new green tag.** Rejected for now: no inbound SSH and no GitHub secrets, but a failure is seen only in the journal and an email, never beside the version in the Actions tab. It stays the choice if SSH must be closed to GitHub's runners.
- **Deploy on every push to `main`.** Rejected: `main` is not a version, and the single-runner E2E record is made only for a `v*` tag.
- **Root's own key in GitHub.** Rejected: a leaked key would be a root shell on the box that holds the Stripe secret key and every customer's Server keys.
- **Run the install directly under the SSH session.** Rejected: a dropped runner or network would leave a half-upgraded instance.

## Consequences

- Port 22 has to accept GitHub's hosted runners, which come from a wide and changing set of addresses. Keys only, the forced command and the pinned host key are what keep that safe.
- A version deploys about 25 minutes after its tag: the E2E run, then a backup and the install on the box. Each upgrade still restarts both units, so customers see a short gap.
- The checkout on the box is fast-forwarded to the tag. A box someone moved ahead of the tag by hand fails the updater's last check rather than being moved back.
- Required reviewers on the `hosted` environment need a paid plan for a private repository, so pushing the tag is the approval, as it is for the CLI's `npm` environment.
