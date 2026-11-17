import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { usePermission } from "@/lib/auth/use-permission";

import { useBoughtServerOffer } from "../server/buy/use-bought-servers";
import { BuyPicker } from "./buy-picker";
import { useWizardPurchases, useWizardServers } from "./use-get-started";
import { AskAdmin, StepNote } from "./wizard-parts";
import { serverBeingMade } from "./wizard-model";
import { wizardHref, type WizardState } from "./wizard-state";

/**
 * The buy path's step one: a size and a place, and Buy. Once a Bought
 * Server is on its way the wizard is on step two, where its stages
 * (ADR-0071) show above the app's details (`DetailsStep`).
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

  const purchase = purchases.data?.find((entry) => entry.id === found);
  const server = servers.data?.find((entry) => entry.serverId === found);
  const stage = server?.boughtServer?.stage ?? purchase?.stage ?? null;

  // A Bought Server on its way, or bought already, goes on to step two,
  // where its progress shows above the app's details. Written into the
  // address, so the wizard keeps following that one Server through a
  // reload and past the purchases list; this covers the way back from
  // Checkout, whose return address cannot name it, and coming back later.
  const router = useRouter();
  const goOn = found !== null && stage !== null;
  useEffect(() => {
    if (goOn) {
      router.replace(
        wizardHref({
          templateId: template.id,
          path: "buy",
          serverId: found,
          deploying: true,
        }),
      );
    }
  }, [goOn, found, router, template.id]);

  if (
    goOn ||
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
