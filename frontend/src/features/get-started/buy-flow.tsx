import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import {
  boughtServersApi,
  type BoughtServerStage,
} from "@/lib/api/endpoints/bought-servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import {
  useBoughtServerOffer,
  useCancelPurchase,
} from "../server/buy/use-bought-servers";
import { BuyPicker } from "./buy-picker";
import { useWizardPurchases, useWizardServers } from "./use-get-started";
import {
  AskAdmin,
  ServerReady,
  StageList,
  StepNote,
} from "./wizard-parts";
import { buyStageStates, serverBeingMade } from "./wizard-model";
import { wizardHref, type WizardState } from "./wizard-state";

/**
 * The buy path: a size and a place, then the Bought Server's stages until
 * it is Ready (ADR-0071).
 *
 * With no plan, Buy goes on to Stripe Checkout, which starts Starter; the
 * purchase sends Checkout the wizard's own address to come back to. That
 * address cannot name the Server, which the same request makes, so on the
 * way back the wizard follows the newest purchase still on its way.
 */
export function BuyFlow({
  template,
  state,
}: {
  template: TemplateSummary;
  state: WizardState;
}) {
  const canBuy = usePermission({ server: ["create"] });
  const offer = useBoughtServerOffer();
  const purchases = useWizardPurchases(
    offer.offered,
    state.checkout === "success",
  );
  // Followed by id once one is known, so the Server row is read again
  // after the purchase leaves the purchases list at Setting up.
  const servers = useWizardServers(
    state.serverId ?? purchases.data?.[0]?.id ?? null,
  );
  const found =
    state.serverId ??
    purchases.data?.[0]?.id ??
    serverBeingMade(servers.data ?? [])?.serverId ??
    null;

  // A purchase found rather than named (back from Checkout, whose return
  // address cannot name it) is written into the address, so the wizard
  // keeps following that one Server through a reload and past the purchases
  // list.
  const router = useRouter();
  useEffect(() => {
    if (!state.serverId && found) {
      router.replace(
        wizardHref({ templateId: template.id, path: "buy", serverId: found }),
      );
    }
  }, [state.serverId, found, router, template.id]);

  if (
    offer.pending ||
    servers.isPending ||
    (offer.offered && purchases.isPending)
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

  const id = found;
  const purchase = purchases.data?.find((entry) => entry.id === id);
  const server = servers.data?.find((entry) => entry.serverId === id);
  const stage = server?.boughtServer?.stage ?? purchase?.stage ?? null;

  if (id && stage) {
    return (
      <BuyProgress
        template={template}
        id={id}
        name={server?.name ?? purchase?.name ?? "Your server"}
        stage={stage}
        cancelled={state.checkout === "cancelled"}
      />
    );
  }

  if (!offer.offered) {
    return (
      <Card>
        <Card.Body className="grid justify-items-start gap-3">
          <p className="text-body text-tx">
            Buying a server isn&rsquo;t available here. You can use a server of
            your own instead.
          </p>
          <LinkButton
            href={wizardHref({ templateId: template.id, path: "own" })}
          >
            Use my own server
          </LinkButton>
        </Card.Body>
      </Card>
    );
  }

  if (!canBuy.allowed) {
    return (
      <Card>
        <Card.Body>
          <AskAdmin>
            Only an owner or an admin can buy a server for this organization.
            Once there is one, come back to this page to deploy {template.name}.
          </AskAdmin>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="grid gap-3">
      {state.checkout === "cancelled" ? (
        <StepNote tone="info">
          You left the payment page before paying, so nothing was charged.
        </StepNote>
      ) : null}
      <BuyPicker template={template} />
    </div>
  );
}

/** A Bought Server on its way, and the next thing to do about it. */
function BuyProgress({
  template,
  id,
  name,
  stage,
  cancelled,
}: {
  template: TemplateSummary;
  id: string;
  name: string;
  stage: BoughtServerStage;
  cancelled: boolean;
}) {
  if (stage === "ready") {
    return (
      <ServerReady
        name={name}
        href={wizardHref({
          templateId: template.id,
          serverId: id,
          deploying: true,
        })}
      />
    );
  }

  if (stage === "failed" || stage === "deleting" || stage === "deleted") {
    return (
      <Card className="animate-fade">
        <Card.Body className="grid justify-items-start gap-3">
          <p className="text-body text-tx">
            {stage === "failed"
              ? "We couldn't create this server, so your payment is being refunded."
              : "This server is being deleted, so it can't be used."}
          </p>
          <LinkButton
            variant="pri"
            href={wizardHref({ templateId: template.id })}
          >
            Choose a server again
          </LinkButton>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="animate-fade">
      <Card.Header
        title={
          stage === "waiting_for_payment"
            ? "Waiting for your payment"
            : `Getting ${name} ready`
        }
        sub={
          stage === "waiting_for_payment"
            ? "The server is made as soon as the payment goes through."
            : "This usually takes a few minutes. You can leave this page; it carries on."
        }
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        <StageList label="Your server" stages={buyStageStates(stage)} />
        {stage === "waiting_for_payment" ? (
          <FinishPaying template={template} id={id} cancelled={cancelled} />
        ) : null}
        {stage === "setting_up" ? (
          // From Setting up on the Server can take the setup, and Cloudgate
          // starts the app by itself once it is Ready (ADR-0073).
          <div className="grid animate-fade justify-items-start gap-2 border-t border-line pt-4">
            <p className="text-body wrap-anywhere text-tx-2">
              No need to wait: tell us about {template.name} now, and it starts
              as soon as the server is ready.
            </p>
            <LinkButton
              variant="pri"
              href={wizardHref({
                templateId: template.id,
                serverId: id,
                deploying: true,
              })}
            >
              Set up {template.name} now
            </LinkButton>
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

/**
 * A purchase whose payment is not finished: back to the payment page, or
 * cancel it, which charges nothing.
 */
function FinishPaying({
  template,
  id,
  cancelled,
}: {
  template: TemplateSummary;
  id: string;
  cancelled: boolean;
}) {
  const invalidate = useInvalidate();
  const finish = useMutation({
    mutationFn: () =>
      boughtServersApi.finishPaying(id, {
        returnTo: wizardHref({ templateId: template.id, path: "buy" }),
      }),
    onSettled: () => invalidate.boughtServers(),
    onSuccess: (result) => {
      if (result.payUrl) window.location.href = result.payUrl;
    },
  });
  const cancel = useCancelPurchase();
  const error = finish.error ?? cancel.error;

  return (
    <div className="grid gap-3">
      {cancelled ? (
        <StepNote tone="info">
          You left the payment page before paying. Finish paying to get the
          server, or cancel and nothing is charged.
        </StepNote>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* `SubmitButton` for its pending state, as `check-inbox` does: the
            label stays and a turning mark says the press was taken. */}
        <SubmitButton
          type="button"
          pending={finish.isPending}
          onClick={() => finish.mutate()}
        >
          Finish paying
        </SubmitButton>
        <SubmitButton
          type="button"
          variant="qt"
          pending={cancel.isPending}
          onClick={() => cancel.mutate(id)}
        >
          Cancel this server
        </SubmitButton>
      </div>
      {error ? (
        <p role="alert" className="text-meta text-bad">
          {errorMessage(error)}
        </p>
      ) : null}
    </div>
  );
}
