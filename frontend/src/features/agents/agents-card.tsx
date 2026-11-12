import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { counted } from "@/lib/format/plural";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { useAgentLifecycle } from "./agent-lifecycle";
import { AgentRow } from "./agent-row";
import { ConnectAgentModal } from "./connect-agent-modal";
import { ConnectPanel } from "./connect-panel";
import { CreateAgentModal } from "./create-agent-modal";
import { DeleteAgentModal } from "./delete-agent-modal";
import { useAgents } from "./use-agents";

/**
 * Every Agent in this Organization, and creating one.
 *
 * **Readable by any member**, as the Members list is:
 * `GET /agents` asks only for membership, so a member without owner or admin
 * sees every row — with every write control off and the reason on it, never
 * hidden (story 11). Those controls read the statements their routes declare
 * — `POST /agents` `member: ['create']` here, `DELETE /agents/:id`
 * `member: ['delete']` on each row — by `usePermission`'s rule;
 * `AgentsService` then admits owner and admin only, as the
 * member-entitlements route does, and both hold those statements.
 */
export function AgentsCard() {
  const agents = useAgents();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [connecting, setConnecting] = useState<Agent | null>(null);
  // Add key reveals through the same Connect panel creation does.
  const lifecycle = useAgentLifecycle({ connect: () => <ConnectPanel /> });

  const canCreate = usePermission({ member: ["create"] });

  const arrival = useArrival(agents.isPending);
  if (agents.isPending) return <SectionPending title="Agents" rows={2} />;
  if (agents.error) {
    return (
      <SectionFailed title="Agents" error={agents.error}>
        Any member of this Organization can read its Agents, so this can also
        mean the session is pointed somewhere you are not a member of.
      </SectionFailed>
    );
  }

  const rows = agents.data ?? [];
  const createButton = (
    <Button
      size="sm"
      variant="pri"
      disabled={!canCreate.allowed}
      title={canCreate.allowed ? undefined : CREATE_REFUSAL}
      onClick={() => canCreate.allowed && setCreating(true)}
    >
      <Icon name="plus" size={14} />
      Create an Agent
    </Button>
  );

  return (
    <Card className={arrival}>
      <Card.Header
        title="Agents"
        sub={`${counted(rows.length, "Agent", "Agents")} in this Organization.`}
        headingLevel={2}
        actions={createButton}
      />
      <Card.Body flush>
        {rows.length === 0 ? (
          <EmptyState icon="cpu" title="No Agents yet" action={createButton}>
            Create an Agent to let a coding agent act on this Organization through
            the MCP endpoint, with its own key and only the role and access you
            give it.
          </EmptyState>
        ) : (
          <ul aria-label="Agents of this Organization">
            {rows.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                onConnect={() => setConnecting(agent)}
                onDelete={() => setDeleting(agent)}
                lifecycle={lifecycle.lifecycleOf(agent)}
              />
            ))}
          </ul>
        )}
      </Card.Body>
      <Card.Footer>
        An Agent acts only through the MCP endpoint, never as a person, and
        every call it makes is in the audit log.
      </Card.Footer>

      {creating ? (
        <CreateAgentModal
          key="create"
          open
          onOpenChange={setCreating}
          connect={() => <ConnectPanel />}
        />
      ) : null}
      {connecting ? (
        <ConnectAgentModal
          key={connecting.id}
          agent={connecting}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setConnecting(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteAgentModal
          key={deleting.id}
          agent={deleting}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setDeleting(null);
          }}
        />
      ) : null}
      {lifecycle.dialogs}
    </Card>
  );
}

const CREATE_REFUSAL = roleRefusal("create an Agent");
