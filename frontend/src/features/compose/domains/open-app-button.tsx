"use client";

import { LinkButton } from "@/components/console/link-button";
import { Icon } from "@/lib/design/icons";

import { useComposeDomains } from "./use-compose-domains";

/**
 * "Open app" in a stack's header: its first Domain's address, in a new tab,
 * the way a Domain's host opens on the Domains tab. Nothing while the stack
 * has no Domain, since it then has no address to open.
 */
export function OpenAppButton({ composeId }: { composeId: string }) {
  const domains = useComposeDomains(composeId);
  const first = domains.data?.[0];
  if (!first) return null;
  const path = first.path && first.path !== "/" ? first.path : "";
  return (
    <LinkButton
      reload
      href={`${first.https ? "https" : "http"}://${first.host}${path}`}
      target="_blank"
      rel="noreferrer noopener"
      title={first.host}
    >
      Open app
      <Icon name="ext" size={14} />
    </LinkButton>
  );
}
