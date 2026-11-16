import { DomainsAsideCard } from "@/features/application/domains/domains-aside";

import { useComposeDomains } from "./use-compose-domains";

/**
 * How this stack is reached, in the rail on its Overview tab: the
 * Application's `DomainsAside` card with one more row, **Service**, since a
 * stack routes each host into one of the services its compose file declares.
 * With no domain it stays, pointing at the Domains tab.
 */
export function ComposeDomainsAside({ composeId }: { composeId: string }) {
  const domains = useComposeDomains(composeId);
  return (
    <DomainsAsideCard
      rows={domains.data}
      pending={domains.isPending}
      tab={`/compose/${composeId}/domains`}
      noun="stack"
      unreached="its services’ internal names reach it"
      service
    />
  );
}
