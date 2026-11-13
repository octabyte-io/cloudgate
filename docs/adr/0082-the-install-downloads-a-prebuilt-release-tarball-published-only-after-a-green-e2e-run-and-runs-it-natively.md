# The install downloads a prebuilt release tarball, published only after a green E2E run, and runs it natively

Status: accepted.

Every install and upgrade cloned the repository into `/opt/cloudgate` and built it on the box: `pnpm install` with node-pty compiled by node-gyp, then `nest build` and `next build`. That needs build-essential, 4 GB of swap and minutes of CPU on a small VPS, and it makes a build failure an install failure.

**A version is one tarball attached to the GitHub Release for its `vX.Y.Z` tag.** It holds the built backend and console, the production `node_modules` with node-pty compiled on Ubuntu 24.04 amd64 (the only platform the install accepts), the migrations and what the install reads from `deploy/`. The install unpacks it and runs it natively under systemd, exactly as before: nothing about how the platform host runs changes.

**A release is published only after its `E2E (release)` run is green**, the same gate the Hosted instance waits for (ADR-0081). A red run publishes nothing, so no box can install an untested version.

**The console reads the API's public address at runtime.** `NEXT_PUBLIC_API_URL` was inlined into the client bundle at build time, which is what tied a build to one box. The console server now reads the address from its environment when it starts and hands it to each page, so one build serves every instance and changing the address is a restart, not a rebuild. `BACKEND_INTERNAL_ORIGIN` stays build-time: it is always loopback on an install.

## Considered Options

- **Docker images on ghcr.io for the backend and console.** Rejected: the backend drives the host's Docker, Traefik, OpenTofu and SSH, so containerising it changes how the whole platform host works, not just how it is delivered.
- **The browser derives the API address from its own location.** Rejected: it guesses wrong for a console domain and for an API on a port other than 4000; one explicit setting stays.
- **Publish as soon as the tag is pushed.** Rejected: anyone installing during the E2E run would get a version nothing has tested.

## Consequences

- The install no longer needs build-essential, python3 or the build's swap for a release install, and an upgrade is a download and a restart.
- A release is tied to Ubuntu 24.04 amd64 through node-pty's compiled module; supporting another platform means another tarball.
