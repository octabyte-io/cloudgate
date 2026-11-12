import { AccessModal } from "@/components/console/access-modal";
import type { Agent } from "@/lib/api/endpoints/agents";

import { LogMaskNotice } from "./log-mask-notice";

/**
 * Widen or narrow what an Agent may reach, after creation.
 *
 * **The dialog is Members' Manage access** — `AccessModal`, the create
 * dialog's tree over `useAccessTree`, and the Members route `PATCH
 * /organizations/members/:id/entitlements` on the Agent's member row, whole
 * set every time (`lib/auth/access-grants.ts` says why). What is the Agent's
 * own here is the wording and the log-mask notice the create step shows,
 * which is as true of a grant made later as of the first.
 */
export function ManageAgentAccessModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AccessModal
      memberId={agent.memberId}
      held={agent}
      name={agent.name}
      subject="Agent"
      title={`Manage ${agent.name}’s access`}
      description="Which Projects, Environments and Services this Agent may reach. Its role decides what it can do there. It takes effect on its next call."
      open={open}
      onOpenChange={onOpenChange}
    >
      <p className="text-body text-tx-2">
        An Agent reaches a Service through its Project and its Environment, so
        granting one grants the two above it.
      </p>
      <LogMaskNotice />
    </AccessModal>
  );
}
