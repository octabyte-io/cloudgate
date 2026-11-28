"use client";

import { notFound } from "next/navigation";
import { useMemo } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import type { BoughtServerCatalogue } from "@/lib/api/endpoints/bought-servers";
import { errorMessage } from "@/lib/api/error-message";
import { useBoughtServerOffer } from "@/lib/api/use-bought-server-offer";

import { BuyOptions } from "./buy-options";
import { BuySummary } from "./buy-summary";
import { useWhereYouAre } from "./location-chooser";
import { useBoughtServerCatalogue } from "./use-bought-servers";
import { useBuyForm } from "./use-buy-form";
import { byDistance } from "./where-you-are";

/**
 * *Buy a Server* (ADR-0071), layout A of #1384's prototype: the map and the
 * Location cards, the size table, the extras, and a summary that stays in
 * view. Hosted only, and only while buying is offered: anywhere else the
 * page does not exist, so it answers the console's not-found.
 *
 * Buy charges at once and sends the customer back to Servers, where the
 * purchase waits for payment or is being made (#1389).
 */
export function BuyScreen() {
  const offer = useBoughtServerOffer();
  const catalogue = useBoughtServerCatalogue(offer.offered);

  if (!offer.pending && !offer.offered) notFound();

  return (
    <Page>
      <PageHeader
        title="Buy a Server"
        icon="hdd"
        lede="Pick where it runs and how big it is, and Cloudgate sets it up for you."
        actions={<LinkButton href="/servers">Back to Servers</LinkButton>}
      />
      {catalogue.error ? (
        <Card>
          <Card.Body>
            <p className="text-body text-tx-2">
              {errorMessage(catalogue.error)}
            </p>
          </Card.Body>
        </Card>
      ) : catalogue.data ? (
        <Chooser catalogue={catalogue.data} />
      ) : (
        <div className="grid gap-4" aria-busy="true">
          <Skeleton className="h-plot" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      )}
    </Page>
  );
}

/** The choices and what they cost, once the catalogue is in. */
function Chooser({ catalogue }: { catalogue: BoughtServerCatalogue }) {
  const { where, askBrowser } = useWhereYouAre();
  // Nothing is picked until the customer picks: the suggestions suggest.
  const form = useBuyForm(catalogue, null);

  const ordered = useMemo(
    () => byDistance(catalogue.locations, where.guess),
    [catalogue.locations, where.guess],
  );

  return (
    <Cols
      aside={
        <BuySummary
          lines={form.lines}
          missing={form.missing}
          choice={form.choice}
        />
      }
      asideLabel="Summary"
      // Stretched, so the rail is as tall as the options and the summary's
      // own `cols:sticky` has room to stick: under `Cols`' `items-start` the
      // rail is only as tall as its card, and it scrolls away.
      className="items-stretch"
    >
      <BuyOptions
        catalogue={catalogue}
        ordered={ordered}
        form={form}
        where={where}
        onAsk={askBrowser}
      />
    </Cols>
  );
}
