import type React from "react";

import {
  CheckDnsButton,
  useDnsCheck,
} from "@/features/application/domains/dns-check";
import { DnsHelper } from "@/features/application/domains/dns-helper";

/**
 * Said by a failed check in a Template setup. The Domain is added by Set up's
 * Plan, so the record can be fixed after it, and the console's other Check DNS
 * is on the stack's Domains tab then.
 *
 * A failed check does not hold Set up back, and the form carries no state for
 * it: DNS is the operator's provider's, often still spreading when the form is
 * sent, and nothing runs until the Plan's Apply anyway. Refusing the setup on
 * a lookup would make a resolver's cache the gate for a choice the operator
 * has already made, and the Add a domain dialog never refuses on it either.
 */
export const SETUP_FAIL_NOTE =
  "DNS changes can take a while to spread, and Set up does not wait for them. Create or correct the record above, then check again here or on the stack's Domains tab.";

/**
 * The Add a domain dialog's DNS panel under a Template setup's Domain field
 * whose host is the operator's own domain, on a Server or this Cloudgate
 * host: the A record to make, from `DnsHelper`, and Check DNS, from
 * `useDnsCheck`. Neither is copied here; this only places them.
 *
 * `pointsAt` is where the record points, null when this Cloudgate host has no
 * public address recorded, which `DnsHelper` says how to set. `beside` is the
 * field's "Generate one for me", kept in one row with Check DNS as the dialog
 * keeps them.
 *
 * A component of its own, mounted only for an own domain, so a setup whose
 * hosts are all generated asks nothing of the query client.
 */
export function SetupDnsCheck({
  host,
  pointsAt,
  beside,
}: {
  host: string;
  pointsAt: string | null;
  beside?: React.ReactNode;
}) {
  const dns = useDnsCheck(host, pointsAt);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {beside}
        <CheckDnsButton check={dns.check} checking={dns.checking} />
      </div>
      <DnsHelper
        host={host}
        serverIp={pointsAt}
        result={dns.result}
        pending={dns.pending}
        noun="stack"
        failNote={SETUP_FAIL_NOTE}
      />
    </>
  );
}
