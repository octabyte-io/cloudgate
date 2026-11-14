# The install accepts Ubuntu 24.04 and 26.04 on amd64, with one tarball

Status: accepted. Amends ADR-0082.

ADR-0082 tied a version to Ubuntu 24.04 amd64 through node-pty's compiled module. Ubuntu 26.04 LTS shipped in April 2026 and is the default image on most providers. **The same tarball, built on 24.04, installs on 24.04 and 26.04 amd64, and the `smoke` job of `publish-version.yml` boots it on both before a version is published.** node-pty links against glibc, which keeps old symbols, so a module built on the older release loads on the newer one. Other releases and other architectures are still refused, by name. The smoke job runs the version against a `postgres:16` service, not the Postgres 26.04 ships, so the first live 26.04 install is still the proof that the version runs against 26.04's own Postgres.

Chosen over a second tarball built on 26.04, which doubles the publish for no gain while one build loads on both, and over staying on 24.04, which refuses the image most new servers start from. arm64 needs its own tarball and arm pins for every downloaded binary, and is planned separately.
