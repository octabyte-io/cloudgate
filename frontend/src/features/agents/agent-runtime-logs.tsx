import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { Agent } from "@/lib/api/endpoints/agents";
import { roleRefusal } from "@/lib/auth/use-permission";

import { useSetAgentRuntimeLogs } from "./use-agents";

/** The switch's name, in the create dialog and on the row (ADR-0095). */
export const RUNTIME_LOGS_LABEL = "Can read runtime logs";

/** The create dialog's line under it: what turning it on hands over. */
export const RUNTIME_LOGS_HINT =
  "What its Services print as they run, which can hold anything their users sent them. Off unless you turn it on.";

/**
 * The mask's stated limit, written beside the switch where it is turned on,
 * as ADR-0095 asks.
 */
const MASK_LIMIT =
  "Cloudgate masks the secrets it stores, not what an app prints.";

const REFUSAL = roleRefusal("change whether an Agent reads runtime logs");

/**
 * An Agent's **Can read runtime logs**, on its row: the state, and the switch
 * that changes it for whoever may change the Agent's role
 * (`PATCH /agents/:id`, `member: ['update']`, owner or admin).
 *
 * Not rendered for a Caller, which never holds it — a switch that is always
 * off and always refused says nothing an operator can act on.
 *
 * No optimistic update, for `DomainGateSwitch`'s reason: the switch shows
 * what the backend holds, so a refused change leaves it where it was.
 */
export function AgentRuntimeLogs({
  agent,
  canUpdate,
}: {
  agent: Agent;
  canUpdate: boolean;
}) {
  const set = useSetAgentRuntimeLogs();

  if (agent.role === "agentCaller") return null;

  return (
    <>
      <dt className="text-tx-3">Runtime logs</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-tx-2">
        <Switch
          size="sm"
          checked={agent.canReadRuntimeLogs}
          disabled={!canUpdate || set.isPending}
          aria-label={RUNTIME_LOGS_LABEL}
          title={canUpdate ? undefined : REFUSAL}
          aria-busy={set.isPending || undefined}
          onCheckedChange={(next) => {
            if (!canUpdate) return;
            set.mutate(
              { agentId: agent.id, canReadRuntimeLogs: next },
              {
                onSuccess: () =>
                  toast.done(
                    next
                      ? `${agent.name} can read runtime logs.`
                      : `${agent.name} can no longer read runtime logs.`,
                  ),
                onError: (error) => toast.error(error),
              },
            );
          }}
        />
        <span>{agent.canReadRuntimeLogs ? "On" : "Off"}</span>
        <span className="text-tx-3">{MASK_LIMIT}</span>
      </dd>
    </>
  );
}
