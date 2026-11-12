import { useState } from "react";

import { toast } from "@/components/console/toast";
import type { Agent, AgentKey, CreatedAgent } from "@/lib/api/endpoints/agents";

import { AddAgentKeyModal } from "./add-agent-key-modal";
import { ChangeAgentRoleModal } from "./change-agent-role-modal";
import { ManageAgentAccessModal } from "./manage-agent-access-modal";
import { RemoveAgentKeyModal } from "./remove-agent-key-modal";
import { SuspendAgentModal } from "./suspend-agent-modal";
import { useSuspendAgent } from "./use-agents";

/** What an Agent's row can ask for after creation. */
export interface AgentLifecycle {
  suspend: () => void;
  resume: () => void;
  changeRole: () => void;
  manageAccess: () => void;
  addKey: () => void;
  removeKey: (key: AgentKey) => void;
  /** A Resume is in flight for this Agent. */
  resuming: boolean;
}

type Open =
  | { kind: "suspend"; agent: Agent }
  | { kind: "role"; agent: Agent }
  | { kind: "access"; agent: Agent }
  | { kind: "addKey"; agent: Agent }
  | { kind: "removeKey"; agent: Agent; key: AgentKey };

/**
 * The dialogs an Agent's life after creation opens — Suspend, Change role,
 * Manage access, Add key, Revoke/Remove — held by the card rather than the
 * row, for the reason `AgentRow` gives: a dialog mounted inside a row
 * unmounts when the list re-renders under it.
 *
 * One dialog is open at a time, so this is one piece of state. Resume opens
 * nothing: it gives back what Suspend kept, so it runs straight from the row
 * and says so in a toast.
 *
 * `connect` is the Add key reveal's client-configuration slot, as
 * `CreateAgentModal`'s is.
 */
export function useAgentLifecycle({
  connect,
}: {
  connect?: (added: CreatedAgent) => React.ReactNode;
} = {}): {
  lifecycleOf: (agent: Agent) => AgentLifecycle;
  dialogs: React.ReactNode;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const resume = useSuspendAgent();
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };

  const lifecycleOf = (agent: Agent): AgentLifecycle => ({
    suspend: () => setOpen({ kind: "suspend", agent }),
    resume: () => {
      resume.mutate(
        { agentId: agent.id, suspended: false },
        {
          onSuccess: () => toast.done(`Resumed ${agent.name}.`),
          onError: (error) => toast.error(error),
        },
      );
    },
    changeRole: () => setOpen({ kind: "role", agent }),
    manageAccess: () => setOpen({ kind: "access", agent }),
    addKey: () => setOpen({ kind: "addKey", agent }),
    removeKey: (key) => setOpen({ kind: "removeKey", agent, key }),
    resuming: resume.isPending && resume.variables?.agentId === agent.id,
  });

  let dialogs: React.ReactNode = null;
  if (open) {
    const key = `${open.kind}:${open.agent.id}`;
    const common = { agent: open.agent, open: true, onOpenChange: close };
    switch (open.kind) {
      case "suspend":
        dialogs = <SuspendAgentModal key={key} {...common} />;
        break;
      case "role":
        dialogs = <ChangeAgentRoleModal key={key} {...common} />;
        break;
      case "access":
        dialogs = <ManageAgentAccessModal key={key} {...common} />;
        break;
      case "addKey":
        dialogs = <AddAgentKeyModal key={key} {...common} connect={connect} />;
        break;
      case "removeKey":
        dialogs = (
          <RemoveAgentKeyModal
            key={`${key}:${open.key.id}`}
            {...common}
            agentKey={open.key}
          />
        );
        break;
    }
  }

  return { lifecycleOf, dialogs };
}
