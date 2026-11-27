# A release candidate is published as a pre-release, and reaches the Hosted instance only when promoted

Status: accepted. Amends [ADR-0081](0081-the-hosted-instance-is-upgraded-by-a-green-version-tag-over-a-key-that-can-run-only-the-updater.md) and [ADR-0082](0082-the-install-downloads-a-prebuilt-release-tarball-published-only-after-a-green-e2e-run-and-runs-it-natively.md).

Some changes can only be checked on a real box: a fresh install, an upgrade over real data, a Server on a real provider. Doing that meant tagging `vX.Y.Z`, and a green `vX.Y.Z` deploys to the Hosted instance by itself (ADR-0081) and becomes the latest version every self-hosted install and update check offers (ADR-0082). So the Hosted instance and every operator got the version before anyone had looked at it.

**A release candidate is a `vX.Y.Z-rc.N` tag on `main`.** It goes through the same `E2E (release)` run and the same `publish-version.yml` build, boots, signing and release as a version, with `backend/package.json` at `X.Y.Z`. Its tarballs are named `X.Y.Z-rc.N`, its `VERSION` and its packed `backend/package.json` say `X.Y.Z-rc.N`, so the Instance reports what it runs, and its GitHub Release is a pre-release. Its publish run never dispatches `deploy-hosted.yml`.

**Nothing installs one unless it is named.** Root `install.sh` and the console's update check count only `vX.Y.Z` tags as the latest version, and they did before this decision, so every instance already out there skips a candidate. `CLOUDGATE_VERSION=v0.3.0-rc.1` installs one. The install orders a candidate before the version it becomes (0.3.13 < 0.3.14-rc.1 < 0.3.14-rc.2 < 0.3.14), so a box on a candidate upgrades to the version, and a box on the version refuses to go back to one of its candidates. `deploy-hosted.yml` and the box's `cloudgate-update` still take `vX.Y.Z` only.

**Promoting a candidate publishes the version from the same commit, without testing it again.** **Promote release candidate** (`promote-release-candidate.yml`, run by hand) checks the candidate's latest `E2E (release)` run passed on the commit its tag still names and that its pre-release carries both signed tarballs, tags `vX.Y.Z` on that commit, and calls `publish-version.yml` with the tag and that commit. That builds and boots the `vX.Y.Z` tarballs, signs and publishes them, and deploys to the Hosted instance as before. The tag is made with `GITHUB_TOKEN`, so it starts no second E2E run. This is the one way other than a green E2E run of the tag itself that `publish-version.yml` starts, and it is still gated by a green E2E run of that commit.

Tagging `vX.Y.Z` directly still works as before, for a version that needs no check on a box.

## Considered Options

- **The GitHub pre-release flag on a `vX.Y.Z` release.** Rejected: root `install.sh` and the update check read the release list and ignore the flag. Teaching them to read it would protect new installs, but every instance already running would still offer the pre-release as an update.
- **Required reviewers on the `hosted` environment.** Rejected as the answer: it holds back the Hosted instance only, while every self-hosted install sees the version at once. It needs a paid plan on a private repository too (ADR-0081). It can still be added beside this.
- **Reusing the candidate's tarballs for the version.** Rejected: a tarball is named for its version and its `VERSION` and signed checksum say so, so the version's would claim to be the candidate. The build and four boots are a few minutes; the tests, which are the slow part, are what is not repeated.

## Consequences

- A version that was a candidate takes two tags: the candidates, then the version. The version is published a few minutes after the promotion, not after another E2E run.
- A fix found on a candidate goes to `main` and gets the next candidate, `rc.N+1`, at the same `backend/package.json` version; its `CHANGELOG.md` entry goes under the version's section.
- A template that needs exactly `X.Y.Z` is refused on its candidates, which report `X.Y.Z-rc.N`, a lower version.
- A box on a candidate is a test box: its console offers the promoted version as an update, and the install upgrades it as it would any older version.
