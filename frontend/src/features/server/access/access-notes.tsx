import { Card } from "@/components/console/card";
import type { Server } from "@/lib/api/endpoints/servers";

import { privilegeFindings } from "../infrastructure/audit-findings";
import { FindingList } from "../infrastructure/finding-list";
import { useServerAudit } from "../use-server";

/** The two audit findings that are about permission rather than installation. */
export function PrivilegeFindings({ server }: { server: Server }) {
  const audit = useServerAudit(server.serverId, server.sshKeyId !== null);

  return (
    <FindingList
      title="What this user may do"
      lede={`Checked on the host as ${server.username}.`}
      query={audit}
      findings={privilegeFindings}
      footer="Setup cannot fix either of these — they are about the account on the machine, so they are changed there. What setup installed is on the Infrastructure tab."
    />
  );
}

/** How the connection is made, since none of it is obvious from the row. */
export function HowItSignsIn({ server }: { server: Server }) {
  return (
    <Card>
      <Card.Header title="How Cloudgate gets in" headingLevel={2} />
      <Card.Body>
        <p className="text-ui text-tx-2">
          There is no agent on the machine. Every reading and every command — a
          deployment, a container restart, the readiness check, the telemetry
          samples, a shell in this console — goes over one SSH connection as{" "}
          <code className="font-mono">{server.username}</code>, authenticated
          with the private half of the key above.
        </p>
        <p className="mt-2.5 text-ui text-tx-2">
          Which means what Cloudgate can do on this Server is exactly what that
          user can do. A user without docker access cannot deploy, whatever role
          somebody holds in this Organization.
        </p>
      </Card.Body>
      <Card.Footer>
        Private keys are encrypted in Cloudgate&rsquo;s own database and are
        never shown on any screen in this console.
      </Card.Footer>
    </Card>
  );
}
