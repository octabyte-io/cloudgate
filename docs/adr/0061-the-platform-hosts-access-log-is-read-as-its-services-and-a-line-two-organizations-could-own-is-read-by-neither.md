# The platform host's access log is read as its Services, and a line two Organizations could own is read by neither

On a self-hosted instance, an Organization other than the Instance organization can run Services on the platform host, but it could not see their requests: the platform host's access log holds every Organization's traffic, so ADR-0013 (H-64) let only the Instance organization's authority read it, and a Service's Requests tab there answered `platform-host` and nothing else (#1337). We now read the platform host's access log the way ADR-0055 reads a Server's: each line goes to whoever holds `service: ['read']` on the Service whose Domain it matched, and the platform host appears on the Requests page for anyone who can read at least one of its lines. This narrows ADR-0013's H-64 bullet for the access log and leaves the rest of that ADR alone.

ADR-0013's concern was that disclosing the log *is* the attack. Here that holds only if a line is attributed to the wrong Organization, so the matching fails closed:

- **A line is matched against every Organization's platform-host Domains**, not only the caller's, so another Organization's `host/blog` is never read as the caller's `host/`.
- **A hostname more than one Organization holds on the platform host is matched by nobody.** Domain claims there are first-come per host but not airtight (no backfill of older rows, an unlocked race), so its lines go to the Instance organization's authority only, and the Service's tab says some of its requests cannot be shown.
- **A line that matches no Domain goes to the Instance organization's authority only.** On a Server it goes to `server: ['read']`, but the platform host has no `server` row, and its unmatched lines include the console's own host and Requested previews' hosts.
- **The Request logging switch stays with the Instance organization's authority.** Another Organization is told logging is off and to ask its admin.

Everything else is ADR-0055's: query values are hidden, an Agent never reads it, an Operator never reads a customer's, and a Frozen Organization still reads its own. It is self-hosted only, since on the Hosted instance no Service runs on the platform host (ADR-0053).

## Considered Options

- **Keep the gate and say so in the tab.** Rejected: every non-instance Organization on a shared self-hosted install stays blind to its own traffic, with moving to its own Server as the only way out.
- **Show such an Organization counts only (requests per hour, status classes), never rows.** Rejected: a third shape of the Requests view, which leaks less only if matching is wrong, and matching is made to fail closed instead.
- **Match against the caller's own Domains, best route wins**, as on a Server. Rejected: on the one machine two Organizations share, a host they both hold would hand one the other's visitors.
