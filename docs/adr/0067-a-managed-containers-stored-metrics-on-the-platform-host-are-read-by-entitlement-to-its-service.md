# A managed container's stored metrics on the platform host are read by entitlement to its Service

ADR-0013 (H-64) put the platform host's branch of the monitoring reads behind the Instance organization's authority, because a base member could read the host's own CPU and memory and list every tenant's container names by substring. The check was placed on the *target*, before any container series was resolved, so it also caught a managed container: on a self-hosted instance, a non-instance Organization's Service on the platform host had its container metrics sampled and stored, but its own owner was refused with `INSTANCE_AUTHORITY_REQUIRED`, and the instance owner was refused by entitlement and told the container had "never been sampled" (#1336). CONTEXT.md's **Managed container** already said entitlement answers a managed container there, and the live stats socket already does.

So for container series the check moves from the target to each series: a **managed** container's stored metrics are read with `service: ['read']` on its Service, in its own Organization, the same rule as the live stats socket; an **unmanaged** container's, and Cloudgate's own `cloudgate-*` series, keep machine access plus instance authority. The host's own metrics keep instance authority. Instance authority still does not read another Organization's Service. This narrows ADR-0013's H-64 bullet for container series only.

## Consequences

- A refusal and a name that matches nothing get one neutral answer, the same status and sentence, so the route does not become an oracle for other Organizations' container names (ADR-0008). It no longer claims the container was never sampled. The cause goes to the journal.
- The hint naming the platform host's metrics exclusion list is shown only to instance authority, since the list is the operator's configuration (ADR-0013's first bullet).
