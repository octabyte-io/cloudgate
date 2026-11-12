import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { LinkButton } from "@/components/console/link-button";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { Server } from "@/lib/api/endpoints/servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";
import { cn } from "@/lib/utils";

import { wholeUsd } from "../server/buy/buy-model";
import {
  useBoughtServerCatalogue,
  useBoughtServerOffer,
} from "../server/buy/use-bought-servers";
import { BuyFlow } from "./buy-flow";
import { OwnFlow } from "./own-flow";
import { useWizardPurchases, useWizardServers } from "./use-get-started";
import { AskAdmin } from "./wizard-parts";
import {
  readyServers,
  serverBeingMade,
  startingPrice,
} from "./wizard-model";
import { wizardHref, type WizardState } from "./wizard-state";

/**
 * Step one: a Server for the app. A Ready Server the Organization already
 * has is offered first; otherwise, or when the person wants a new one, the
 * two ways to get one. A Bought Server already on its way (back from
 * Checkout, or a reload while it is made) is followed rather than offered
 * again.
 */
export function ServerStep({
  template,
  state,
}: {
  template: TemplateSummary;
  state: WizardState;
}) {
  if (state.path === "buy") {
    return <BuyFlow template={template} state={state} />;
  }
  if (state.path === "own") {
    return <OwnFlow template={template} state={state} />;
  }
  return <ChooseServer template={template} state={state} />;
}

function ChooseServer({
  template,
  state,
}: {
  template: TemplateSummary;
  state: WizardState;
}) {
  const servers = useWizardServers();
  const offer = useBoughtServerOffer();
  const purchases = useWizardPurchases(offer.offered, false);
  const canAdd = usePermission({ server: ["create"] });
  const [wantsNew, setWantsNew] = useState(false);

  if (servers.error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(servers.error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (servers.isPending || offer.pending) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-32" />
        </Card.Body>
      </Card>
    );
  }

  // A Bought Server already on its way is the one this person is waiting
  // for: follow it on the buy path.
  const coming =
    purchases.data?.[0]?.id ?? serverBeingMade(servers.data)?.serverId;
  if (coming) {
    return (
      <BuyFlow
        template={template}
        state={{ ...state, path: "buy", serverId: null }}
      />
    );
  }

  const ready = readyServers(servers.data);
  const showWays = ready.length === 0 || wantsNew;

  return (
    <Card className="animate-fade">
      <Card.Header
        title={`Where should ${template.name} run?`}
        sub={
          ready.length > 0
            ? "Use a server you already have, or get a new one."
            : "Apps run on a server: a computer that is always on and online."
        }
        headingLevel={2}
      />
      <Card.Body className="grid gap-5">
        {ready.length > 0 ? (
          <ExistingServers template={template} servers={ready} />
        ) : null}
        {ready.length > 0 && !wantsNew ? (
          <div>
            <Button variant="qt" size="sm" onClick={() => setWantsNew(true)}>
              Get a new server instead
            </Button>
          </div>
        ) : null}
        {showWays ? (
          // Rises only when asked for: shown from the start, it arrives with
          // the card around it.
          <div className={cn("grid", wantsNew && "animate-rise")}>
            {canAdd.allowed ? (
              <WaysToGetOne template={template} buyable={offer.offered} />
            ) : (
              <AskAdmin>
                Only an owner or an admin can add a server to this
                organization. Once there is one, come back to this page to
                deploy {template.name}.
              </AskAdmin>
            )}
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

/** The Organization's Ready Servers: one to confirm, or several to pick from. */
function ExistingServers({
  template,
  servers,
}: {
  template: TemplateSummary;
  servers: Server[];
}) {
  const [chosen, setChosen] = useState(servers[0].serverId);
  const server = servers.find((one) => one.serverId === chosen) ?? servers[0];
  return (
    <div className="grid gap-3">
      {servers.length > 1 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-body font-medium text-tx">
            Your servers
          </legend>
          {servers.map((one) => (
            <label
              key={one.serverId}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 transition-colors duration-100 hover:border-line-2 has-checked:border-brand has-checked:bg-brand-tint"
            >
              <input
                type="radio"
                name="server"
                value={one.serverId}
                checked={chosen === one.serverId}
                onChange={() => setChosen(one.serverId)}
                className="flex-none accent-brand"
              />
              <span className="min-w-0 text-body wrap-anywhere text-tx">
                {one.name}
              </span>
              <span className="ml-auto flex-none font-mono text-meta text-tx-3">
                {one.ipAddress}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-body wrap-anywhere text-tx">
          Your server <strong className="font-semibold">{server.name}</strong>{" "}
          is ready for {template.name}.
        </p>
      )}
      <div className="min-w-0">
        <LinkButton
          variant="pri"
          className="max-w-full"
          href={wizardHref({
            templateId: template.id,
            serverId: server.serverId,
            deploying: true,
          })}
        >
          {/* One text node, truncated: a long Server name must not push the
              button past the card. */}
          <span className="truncate">{`Use ${server.name}`}</span>
        </LinkButton>
      </div>
    </div>
  );
}

/**
 * A way-to-get-one card is a link to the next step, so it answers the pointer:
 * the border firms on hover and the card gives slightly on press. Colour and
 * scale only, so nothing around it moves.
 */
const WAY_CARD =
  "transition-[border-color,scale] duration-100 ease-out-strong active:scale-99";

/** The two ways to get a Server; buying only where this instance sells one. */
function WaysToGetOne({
  template,
  buyable,
}: {
  template: TemplateSummary;
  buyable: boolean;
}) {
  const catalogue = useBoughtServerCatalogue(buyable);
  const from = catalogue.data ? startingPrice(catalogue.data) : null;
  return (
    <PickGrid label="Ways to get a server">
      {buyable ? (
        <PickCard
          icon="rocket"
          render={
            <Link
              href={wizardHref({ templateId: template.id, path: "buy" })}
              className={WAY_CARD}
            />
          }
          title={
            <span className="flex flex-wrap items-center gap-2">
              Get a server from Cloudgate
              <Chip variant="ok">Recommended</Chip>
            </span>
          }
          description="We create the server and set it up for you. Nothing technical to do."
          footer={
            <span className="text-meta text-tx-2">
              {from !== null ? `From ${wholeUsd(from)} a month, ` : ""}
              billed monthly with your plan.
            </span>
          }
        />
      ) : null}
      <PickCard
        icon="server"
        render={
          <Link
            href={wizardHref({ templateId: template.id, path: "own" })}
            className={WAY_CARD}
          />
        }
        title="Use my own server"
        description="For a server you already rent, such as a VPS. You need its address and SSH access to it."
      />
    </PickGrid>
  );
}
