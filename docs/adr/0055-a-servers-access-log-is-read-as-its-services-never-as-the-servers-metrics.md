# A Server's access log is read as its Services, never as the Server's metrics

The Requests page is coming back for customers by reading each Server's own Traefik access log. Those lines hold the visitor IPs, paths, query strings and User-Agents of every Service on the Server. We decided who may read them:

- **Reading is per Service.** A line that matches a Service's Domain is shown only to a caller holding `service: ['read']` on that Service, through the same entitlement check as its Uptime checks, Trace store and Runtime log. Lines that match no Service, such as scanners and unknown hosts, are shown only to a caller holding `server: ['read']` (owners, admins, and custom roles granted it).
- **Query values are hidden on read** and their names kept (`/reset?token=***`), with no switch to show them. Traefik can only keep or drop the whole path, so the file on the customer's disk keeps the query in full. Visitor IPs and the User-Agent are shown in full. The Server's Traefik is configured to drop every request header except User-Agent.
- **A Frozen Organization still reads it** (ADR-0052: members see everything). The reads are `GET`s, or count as reads to the frozen guard. Any background collection stops while frozen, like metrics sampling, and the page shows what was last collected.
- **No Operator reads it** (ADR-0050). Authority over the platform host covers only the platform host's own log.
- **No Agent reads it.** No agent role gets it and no MCP tool returns it (ADR-0024: visitor IPs and URLs are not something we would accept being public forever). The Error rate stays the Agent's way to see whether a Service is failing.

## Considered Options

- **`monitoring: ['read']`.** Rejected: the base member role holds it, and it is checked per Server only, so a member granted one Service would read the traffic of every other Service on that Server.
- **A new `requestLog: ['read']` statement.** Rejected: one more statement to grant by hand on every custom role, and still needing a per-Service filter on top.
- **Showing the raw query string.** Rejected: password-reset and signed-download tokens travel in it, and Cloudgate never shows a stored secret back (ADR-0019).

## Consequences

- The reader has to map each line to a Service, by its router, before it can filter. A line it cannot map counts as matching no Service.
- Who sees which Servers on the page follows from this: a Server shows for a caller who can read at least one of its lines.
