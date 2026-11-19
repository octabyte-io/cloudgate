import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Skeleton } from "@/components/console/skeleton";
import type {
  BoughtServerCatalogue,
  PurchaseResult,
} from "@/lib/api/endpoints/bought-servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";

import { SUGGESTED_MEMORY_GB } from "../server/buy/buy-model";
import { BuyOptions } from "../server/buy/buy-options";
import { BuySummary } from "../server/buy/buy-summary";
import { useWhereYouAre } from "../server/buy/location-chooser";
import { closestAndCheapest } from "../server/buy/suggestions";
import { useBoughtServerCatalogue } from "../server/buy/use-bought-servers";
import { useBuyForm } from "../server/buy/use-buy-form";
import { byDistance } from "../server/buy/where-you-are";
import { wizardHref } from "./wizard-state";

/**
 * *Buy a Server* inside the wizard: the Buy screen's own two columns and
 * parts (`features/server/buy/`), every option on the left and the summary
 * with Buy on the right, kept in view, and the same Location card with its
 * map (#127). It opens on the Closest suggestion, worked out from the
 * browser's time zone here and never sent, so a first-time buyer can press
 * Buy without choosing anything.
 *
 * Unlike the Buy screen, Buy comes back to the wizard: Checkout and a
 * bank's check return to it, and a Server charged at once is followed here.
 */
export function BuyPicker({ template }: { template: TemplateSummary }) {
  const catalogue = useBoughtServerCatalogue(true);

  if (catalogue.error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(catalogue.error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (!catalogue.data) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </Card.Body>
      </Card>
    );
  }
  const buyable = catalogue.data.sizes.some((size) =>
    size.offers.some((offer) => offer.available),
  );
  if (!buyable) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">
            No server can be bought right now. Try again later, or use a server
            of your own.
          </p>
        </Card.Body>
      </Card>
    );
  }
  return <Chooser template={template} catalogue={catalogue.data} />;
}

function Chooser({
  template,
  catalogue,
}: {
  template: TemplateSummary;
  catalogue: BoughtServerCatalogue;
}) {
  const router = useRouter();
  const { where, askBrowser } = useWhereYouAre();
  const ordered = useMemo(
    () => byDistance(catalogue.locations, where.guess),
    [catalogue.locations, where.guess],
  );
  // Worked out once, from the time zone: the form opens on it, and is the
  // buyer's from then on, so Show where I am reorders the cities but does not
  // change a choice.
  const [start] = useState(
    () =>
      closestAndCheapest(ordered, catalogue.sizes, SUGGESTED_MEMORY_GB).closest,
  );
  const form = useBuyForm(catalogue, start);

  function bought(result: PurchaseResult) {
    // Checkout (no plan yet) or a bank's check: the page to pay on.
    if (result.payUrl) window.location.href = result.payUrl;
    else
      router.replace(
        wizardHref({
          templateId: template.id,
          path: "buy",
          serverId: result.id,
          // Straight on to the app's details, the Server's progress above them.
          deploying: true,
        }),
      );
  }

  return (
    <Cols
      aside={
        <BuySummary
          lines={form.lines}
          missing={form.missing}
          choice={form.choice}
          returnTo={wizardHref({ templateId: template.id, path: "buy" })}
          onBought={bought}
        />
      }
      asideLabel="Summary"
      // Stretched, so the rail is as tall as the options and the summary's
      // own `cols:sticky` has room to stick (as on the Buy screen).
      className="animate-fade items-stretch"
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
