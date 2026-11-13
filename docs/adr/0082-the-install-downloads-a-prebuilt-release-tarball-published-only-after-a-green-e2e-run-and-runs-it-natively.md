# The install downloads a prebuilt release tarball, published only after a green E2E run, and runs it natively

Status: accepted.

Every install and upgrade cloned the repository into `/opt/cloudgate` and built it on the box: `pnpm install` with node-pty compiled by node-gyp, then `nest build` and `next build`. That needs build-essential, 4 GB of swap and minutes of CPU on a small VPS, and it makes a build failure an install failure.

**A version is one tarball attached to the GitHub Release for its `vX.Y.Z` tag.** It holds the built backend and console, the production `node_modules` with node-pty compiled on Ubuntu 24.04 amd64 (the only platform the install accepts), the migrations and what the install reads from `deploy/`. The install unpacks it and runs it natively under systemd, exactly as before: nothing about how the platform host runs changes.

**A release is published only after its `E2E (release)` run is green**, the same gate the Hosted instance waits for (ADR-0081). A red run publishes nothing, so no box can install an untested version.

**Only a tag on `main` is published, and the publish gate is where that is checked.** `deploy/version-gate.sh` refuses a tag whose commit is not on `origin/main` before anything is built, so a green tag cut from a branch never becomes the latest version every Self-hosted box installs. The Hosted instance's deploy workflow checks it again on its runner before it reaches the box. The box itself no longer checks it: it installs a published version and has no checkout to ask.

**The install only ever installs a Cloudgate version.** The latest by default, or the one `CLOUDGATE_VERSION` names. It no longer clones, builds or takes a branch: `CLOUDGATE_REF` goes, and building from source is a by-hand developer path in `docs/deploy.md`. A box still holding a git checkout at `/opt/cloudgate` is switched over by the next run: the checkout is moved aside, the version is unpacked in its place, and `/etc/default/cloudgate-*` and the database, which are the instance's identity, are kept.

**The Hosted instance installs the same tarball.** Its updater (ADR-0081) downloads the version's release instead of fast-forwarding a checkout to the tag, and the deploy starts once the release is published rather than when E2E ends. This replaces two parts of ADR-0081: "the checkout on the box is fast-forwarded to the tag", and the updater's own check that the tag's commit is on `origin/main`, which now lives in the publish gate and the deploy workflow (above). The release gate, the key and the unit it describes are unchanged.

**The console reads the API's public address at runtime.** `NEXT_PUBLIC_API_URL` was inlined into the client bundle at build time, which is what tied a build to one box. The console server now reads the address from its environment when it starts and hands it to each page, so one build serves every instance and changing the address is a restart, not a rebuild. `BACKEND_INTERNAL_ORIGIN` stays build-time: it is always loopback on an install.

## Considered Options

- **Docker images on ghcr.io for the backend and console.** Rejected: the backend drives the host's Docker, Traefik, OpenTofu and SSH, so containerising it changes how the whole platform host works, not just how it is delivered.
- **The browser derives the API address from its own location.** Rejected: it guesses wrong for a console domain and for an API on a port other than 4000; one explicit setting stays.
- **Keep `CLOUDGATE_REF=<branch>` building from source beside the release path.** Rejected: two install paths to keep working, and the source one keeps build-essential, swap and the builds in the script for the few runs that use it.
- **Publish as soon as the tag is pushed.** Rejected: anyone installing during the E2E run would get a version nothing has tested.

## Consequences

- The install no longer needs build-essential, python3 or the build's swap, and an upgrade is a download, the migrations and a restart.
- An unreleased fix reaches a box only by hand or by tagging a version; staging a branch is a developer's by-hand build.
- The console's update notice can now answer: it compares the running version with the latest Cloudgate version on GitHub Releases.
- A release is tied to Ubuntu 24.04 amd64 through node-pty's compiled module; supporting another platform means another tarball.
