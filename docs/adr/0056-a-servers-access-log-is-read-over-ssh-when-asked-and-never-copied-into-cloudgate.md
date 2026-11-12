# A Server's access log is read over SSH when asked, and never copied into Cloudgate

Decided while planning Requests for every customer Server. ADR-0027 kept the Error rate off the access log and said that needing a per-request fact (a path, a visitor) would be "a new decision about shipping request records". This is that decision.

The **Requests** page reads a Server's own Traefik access log (`/etc/cloudgate/traefik/dynamic/access.log`) **over SSH, when someone opens the page**, on the Server's pooled connection (`SshForwardService`). Cloudgate stores nothing it reads: visitor IPs and URLs (query strings included, which Traefik cannot drop on their own) stay on the customer's Server.

- **One bounded read per load.** Backwards from the end of the current file, at most about 16 MiB (some 20,000 requests), with standard commands only (`tail -c`, `wc -c`). When the bound or the start of the file stops the read before the start of the range, the page says how far back it reached ("retained from"), never a quiet hour. Rotated files (`access.log.1` and after) are not read.
- **Filtering happens in Cloudgate**, with the one parser both readers share; nothing assumes `jq` on a Server. That is also where ADR-0055 splits the lines by Service before anyone sees them.
- **The pure parts of the platform host reader are shared**: the parser, hour bucketing, totals, the stop rule and "retained from". The stop rule allows for lines landing late by up to a request's duration, since Traefik writes in completion order. The hour index, inode fingerprint and in-process cache are local-disk machinery and are not carried over. The platform host reader itself is unchanged.
- **No lines is never 0 requests.** Unreachable Server, logging off, logging on but Traefik not yet restarted, empty file, and a read stopped after about 10 seconds are each their own state.

**Considered options.**

- **A periodic pull into Cloudgate.** Rejected. It would hold every customer's visitor data for every Server, whether anyone looks or not, with a retention promise to keep, and its cost grows with traffic rather than with use. What it buys (history while a Server is offline, totals across Servers) was not needed.
- **The Server pushing lines or summaries.** Rejected for the reason ADR-0027 gave: there is no inbound path from a Server and no agent on it, and `accesslog.otlp` is experimental.

**Consequences.** An offline Server shows no requests, only that it cannot be reached. A range older than the read bound reaches is not shown; jumping straight to an old range (probing the file by byte offset) is a possible later step, not part of this. **What would falsify this:** a need for request history that outlives the Server's own file, or a view across many Servers at once. That is a new decision about storing visitor data, not a reason to add a pull beside this reader.
