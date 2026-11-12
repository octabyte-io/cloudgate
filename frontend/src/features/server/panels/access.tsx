"use client";

import type { PanelProps } from "@/lib/shell/tab-registry";

import { HowItSignsIn, PrivilegeFindings } from "../access/access-notes";
import { HostKeyCard } from "../access/host-key-card";
import { KeyCard } from "../access/key-card";
import { ServerPanel } from "../server-panel";

/**
 * How Cloudgate gets in, and what it can do once it is in.
 *
 * Three cards: the key this Server uses, the host key it presents back (ADR-0074), and the two audit
 * findings about **privilege** — which is the other half of "access". The four findings
 * about what setup installed are on the Infrastructure tab, off the same query and the
 * same cache key, so opening both tabs costs one SSH session.
 *
 * The reference's Access tab also has a firewall table and a members list. Both are
 * absent: **the firewall rows were "as Terraform last applied it"** and there is no
 * Terraform and no firewall route, and **members are an Organization-wide role** —
 * there is no per-Server permission to list, so a table of three names beside a Server
 * would imply an access model that does not exist. Roles are F16's screen.
 */
export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <HowItSignsIn server={server} />}
    >
      {(server) => (
        <>
          <KeyCard server={server} />
          <HostKeyCard server={server} />
          <PrivilegeFindings server={server} />
        </>
      )}
    </ServerPanel>
  );
}
