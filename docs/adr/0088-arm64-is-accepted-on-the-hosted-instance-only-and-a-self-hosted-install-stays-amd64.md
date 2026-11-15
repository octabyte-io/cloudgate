# arm64 is accepted on the Hosted instance only, and a Self-hosted install stays amd64

Status: accepted. Amends ADR-0085.

ADR-0085 accepted Ubuntu 24.04 and 26.04 on amd64 and refused every other architecture, leaving arm64 "planned separately". **A Cloudgate version is now published as two tarballs, `linux-amd64` and `linux-arm64`, and the install accepts arm64 only with hosted mode on.** A Self-hosted install on an arm64 platform host is still refused, by name, even though the arm64 tarball sits on the same public GitHub Release. Servers are unaffected: they already run on either CPU.

Chosen over arm64 for every instance, which would make every Self-hosted operator's arm64 box a supported platform, with its own upgrade, support and Cloud Run questions (a git build for Cloud Run cannot run on an arm64 platform host without emulation), for a gain only the Hosted instance needs today. The Hosted instance builds nothing on its platform host (ADR-0047, ADR-0053), so none of those questions reach it. Opening arm64 to Self-hosted later is lifting one refusal in the install, since the tarball and the arm64 pins already exist.
