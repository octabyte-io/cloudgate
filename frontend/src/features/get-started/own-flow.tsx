import Link from "next/link";

import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { usePermission } from "@/lib/auth/use-permission";

import { OwnConnect } from "./own-connect";
import { OwnServerForm } from "./own-server-form";
import { PlanStep } from "./plan-step";
import { useWizardServerRoom } from "./use-get-started";
import { AskAdmin } from "./wizard-parts";
import type { WizardState } from "./wizard-state";

/**
 * The own-server path: a plan first where the Hosted instance needs one
 * (ADR-0054: no plan allows no Server), then the Server's address and key,
 * then its setup, started by the person's "Connect my server" (ADR-0058).
 */
export function OwnFlow({
  template,
  state,
}: {
  template: TemplateSummary;
  state: WizardState;
}) {
  const canAdd = usePermission({ server: ["create"] });
  const room = useWizardServerRoom(state.checkout === "success");

  if (!canAdd.allowed) {
    return (
      <Card>
        <Card.Body>
          <AskAdmin>
            Only an owner or an admin can add a server to this organization.
            Once there is one, come back to this page to deploy {template.name}.
          </AskAdmin>
        </Card.Body>
      </Card>
    );
  }

  if (state.serverId) {
    return <OwnConnect template={template} serverId={state.serverId} />;
  }

  if (room.isPending) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-40" />
        </Card.Body>
      </Card>
    );
  }

  // A failed read is not a refusal: Server create checks the plan itself.
  const code = room.data?.code ?? null;
  if (code === "PLAN_REQUIRED") {
    return <PlanStep template={template} checkout={state.checkout} />;
  }
  if (code === "ALLOWANCE_FULL") {
    return (
      <Card>
        <Card.Body className="grid gap-2">
          <p className="text-body text-tx">
            Your plan already has all the servers it allows.
          </p>
          <p className="text-ui text-tx-2">
            An owner or admin can add room for one more on the{" "}
            <Link
              href="/settings/billing"
              className="text-brand-tx underline underline-offset-2"
            >
              Billing page
            </Link>
            , or you can use one of your servers that is already set up.
          </p>
        </Card.Body>
      </Card>
    );
  }

  return <OwnServerForm template={template} />;
}
