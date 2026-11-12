# A cloud Domain's host is unique per Organization, not across the instance

A Domain on a Server is a Traefik router, and one Traefik can route a host only once, so a Server Domain claims its host on that Server: another Organization's Domain on the same Server (on the platform host, the only Server two Organizations share) is refused with "This hostname is already in use". Cloud Domains were put in the same scope as the platform host, because they have no Server either. But nothing proves who owns a hostname, so one customer could add `api.customer-b.com` to their own cloud Service first and block customer B from their own domain until they removed it. Nothing was stolen, since nothing routes until DNS points at the holder, but B was locked out.

So a cloud Domain's host is unique only inside its Organization. Two Organizations may both hold the same host on their own cloud Services; DNS and the cloud's own certificate (ACM or Google-managed) decide which one actually serves it. A cloud Domain reaches no Traefik, so it also holds nothing against another Organization's Server Domains, and they hold nothing against it. Inside one Organization nothing changes: the same host and path is still refused, and on Google Cloud a host is still one Domain. The console's own host stays reserved for everyone.

## Considered Options

- **Prove the host with a DNS TXT record before it is held**, as a Proven domain is for SSO (ADR-0051). Rejected for now: it adds a step to every customer's every Domain, and the cloud's certificate already needs a DNS record the holder must control before anything is served.
- **Let an Operator release a squatted hostname.** Rejected: it keeps the lock-out and only shortens it, and costs a support ticket each time.

## Consequences

- Two `domain` rows in different Organizations may name one host, each with its own certificate request. The one whose DNS records exist gets the certificate; the other waits for DNS and fails after 72 hours, like any Domain whose records never came.
- The Server rule is unchanged: a Server Domain's host is claimed per Server, and the `(host, path)` pair stays instance-wide among Server Domains.
