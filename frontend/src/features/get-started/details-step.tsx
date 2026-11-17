import { useState } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import type { BoughtServerStage } from "@/lib/api/endpoints/bought-servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { useProjects } from "@/lib/api/use-projects";

import { DetailsForm } from "./details-form";
import { ServerGone, ServerProgress } from "./server-progress";
import { NEW_PROJECT, useSetupForm } from "../templates/use-templates";
import {
  useWizardPurchases,
  useWizardServers,
  WAIT_POLL_MS,
} from "./use-get-started";
import { canSetUpOn, waitsForGeneratedHost } from "./wizard-model";
import { wizardHref } from "./wizard-state";

/**
 * Step two: Template setup's own fields (`DetailsForm`): the asked
 * values and each web address in view, the Project and the setup name
 * under More options with their defaults said in one line, and Deploy.
 *
 * Right after Buy the wizard is already here, with the Bought Server's
 * progress in a strip above the form: the details are filled in while it
 * is made, Deploy opens once it has a Server row (Setting up), and
 * Cloudgate applies the setup once it is Ready (ADR-0073).
 */
export function DetailsStep({
  template,
  serverId,
  bought,
  leftPayment = false,
}: {
  template: TemplateSummary;
  serverId: string;
  /** Back from a cancelled Checkout: the strip says the payment page was left. */
  leftPayment?: boolean;
  /**
   * Whether the Server was just bought here (the buy path): its progress
   * then sits above the form, and the form is open while it is still made.
   */
  bought: boolean;
}) {
  // On the buy path both are followed until the Server is Ready: the
  // purchase until its Server row exists (Setting up), the row after.
  const servers = useWizardServers(bought ? serverId : undefined);
  const purchases = useWizardPurchases(bought, false);
  // The new-Project form, asked again on the buy path until it has the
  // Bought Server's generated host.
  const form = useSetupForm(template.id, NEW_PROJECT, {
    askAgain: (read) =>
      bought && waitsForGeneratedHost(read, serverId) ? WAIT_POLL_MS : false,
  });
  const projects = useProjects();
  const server = servers.data?.find((entry) => entry.serverId === serverId);
  const purchase = purchases.data?.find((entry) => entry.id === serverId);
  const stage = useLastStage(
    bought ? (server?.boughtServer?.stage ?? purchase?.stage ?? null) : null,
  );
  const error = servers.error ?? form.error ?? projects.error;
  if (error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (
    !servers.data ||
    !form.data ||
    !projects.data ||
    (bought && purchases.isPending)
  ) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-40" />
        </Card.Body>
      </Card>
    );
  }

  if (stage && GONE.includes(stage)) {
    return <ServerGone template={template} stage={stage} />;
  }

  // Before Setting up there is no Server row to set the app up on yet, but
  // the details can be filled in already; Deploy waits for the row.
  const beingMade = stage === "waiting_for_payment" || stage === "creating";
  if (!beingMade && (!server || !canSetUpOn(server))) {
    return (
      <Card>
        <Card.Body className="grid justify-items-start gap-3">
          <p className="text-body text-tx">
            That server isn&rsquo;t ready for an app yet.
          </p>
          <LinkButton href={wizardHref({ templateId: template.id })}>
            Choose a server
          </LinkButton>
        </Card.Body>
      </Card>
    );
  }

  const refusal = form.data.deployTargets.server;
  if (refusal) {
    return (
      <Card>
        <Card.Body className="grid gap-2">
          <p className="text-body text-tx">
            {`${template.name} can’t run on a server like this one.`}
          </p>
          <p className="text-ui text-tx-2">{refusal}</p>
        </Card.Body>
      </Card>
    );
  }

  const name = server?.name ?? purchase?.name ?? "Your server";
  return (
    <div className="grid gap-4.5">
      {stage ? (
        <ServerProgress
          template={template}
          id={serverId}
          name={name}
          stage={stage}
          leftPayment={leftPayment}
        />
      ) : null}
      {/* In the same place whether or not the strip shows, so what was typed
          stays as the Server moves through its stages. */}
      <DetailsForm
        template={template}
        setup={form.data}
        projects={projects.data}
        serverId={serverId}
        serverName={name}
        canDeploy={server !== undefined && canSetUpOn(server)}
      />
    </div>
  );
}

/** A Bought Server that will never take the app. */
const GONE: readonly BoughtServerStage[] = ["failed", "deleting", "deleted"];

/**
 * The stage last seen, held while neither read has the Server: the
 * purchase leaves the purchases list at Setting up, and the Server row is
 * read a poll later, which must not unmount the form in between.
 */
function useLastStage(
  stage: BoughtServerStage | null,
): BoughtServerStage | null {
  const [last, setLast] = useState(stage);
  if (stage !== null && stage !== last) setLast(stage);
  return stage ?? last;
}
