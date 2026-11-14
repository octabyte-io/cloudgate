# A Cloudgate version is signed, and the install refuses one whose signature does not verify

Status: accepted.

The `.sha256` beside a version's tarball comes from the same GitHub Release, so it proves the download arrived whole, not that we published it: anyone who can write a release can replace both. **The publish workflow signs the checksum with an SSH key held as a GitHub Actions secret, and `install.sh` carries the public key and verifies the signature with `ssh-keygen -Y verify` before anything is unpacked.** A version without a valid signature is refused, with nothing changed. `ssh-keygen` is on every Ubuntu host, so the box needs no new tool.

Chosen over Sigstore keyless signing, which needs no key to look after but makes every box download `cosign` before it can verify anything, and over GitHub artifact attestations alone, which only someone with `gh` checks: the box would still trust the checksum. The cost is one secret to keep and rotate; a rotation ships the new public key in `install.sh` before the first version signed with it.
