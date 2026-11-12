import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  BoughtServerCatalogue,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { cn } from "@/lib/utils";

import {
  FAMILIES,
  countryName,
  offerIn,
  sizeLabel,
  wholeUsd,
} from "../server/buy/buy-model";
import { BuyNote } from "../server/buy/buy-note";
import { TICK_TERMS, centsUsd, todayText } from "../server/buy/buy-summary";
import { LocationCards } from "../server/buy/location-cards";
import { SizeTable } from "../server/buy/size-table";
import {
  useBoughtServerCatalogue,
  useBoughtServerToday,
  useBuyServer,
} from "../server/buy/use-bought-servers";
import {
  browserTimeZone,
  byDistance,
  guessFromTimeZone,
} from "../server/buy/where-you-are";
import { suggestedLocation, suggestedSize } from "./wizard-model";
import { wizardHref } from "./wizard-state";

/**
 * *Buy a Server*, cut down for someone who does not know what a vCPU is: a
 * suggested place (the nearest, from the browser's time zone, worked out
 * here and never sent) and a suggested size, each with a way to change it,
 * then the price, today's charge and Buy.
 *
 * The parts are the Buy screen's own (`features/server/buy/`): the Location
 * cards, the size table, today's charge and its sentence, the terms and the
 * deletion warning. Only the summary is not, because the Buy screen's sends
 * the buyer on to Servers, and this one comes back to the wizard.
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
  return <Chooser template={template} catalogue={catalogue.data} />;
}

function Chooser({
  template,
  catalogue,
}: {
  template: TemplateSummary;
  catalogue: BoughtServerCatalogue;
}) {
  const ordered = useMemo(
    () =>
      byDistance(catalogue.locations, guessFromTimeZone(browserTimeZone())),
    [catalogue.locations],
  );
  const [locationId, setLocationId] = useState<string | null>(
    () => suggestedLocation(ordered, catalogue.sizes)?.id ?? null,
  );
  const [sizeId, setSizeId] = useState<string | null>(() =>
    locationId
      ? (suggestedSize(catalogue.sizes, locationId)?.id ?? null)
      : null,
  );
  const [changingPlace, setChangingPlace] = useState(false);
  const [allSizes, setAllSizes] = useState(false);
  const [family, setFamily] = useState<SizeFamily>("shared");

  const location =
    catalogue.locations.find((entry) => entry.id === locationId) ?? null;
  const size = catalogue.sizes.find((entry) => entry.id === sizeId) ?? null;
  const offer = size && location ? offerIn(size, location.id) : undefined;

  function choosePlace(next: string) {
    setLocationId(next);
    // The size goes with the place: keep it where it can be bought there.
    const kept = size ? offerIn(size, next) : undefined;
    if (!kept?.available) {
      setSizeId(suggestedSize(catalogue.sizes, next)?.id ?? null);
    }
  }

  if (!location) {
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

  return (
    <Card className="animate-fade">
      <Card.Header
        title="Your new server"
        sub={`We picked a size that suits ${template.name} and the place nearest you. Change either if you like.`}
        headingLevel={2}
      />
      <Card.Body className="grid gap-5">
        <section aria-labelledby="buy-where" className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="buy-where" className="text-body font-medium text-tx">
              Where it runs
            </h3>
            <Button
              variant="qt"
              size="sm"
              aria-expanded={changingPlace}
              onClick={() => setChangingPlace((now) => !now)}
            >
              {changingPlace ? "Done" : "Other places"}
            </Button>
          </div>
          <p className="text-body text-tx-2">
            {location.city}, {countryName(location.country)}
          </p>
          {changingPlace ? (
            // Asked for, so it rises in under the button that opened it.
            <div className="animate-rise">
              <LocationCards
                ordered={ordered}
                chosen={location.id}
                onChoose={choosePlace}
              />
            </div>
          ) : null}
        </section>

        <section aria-labelledby="buy-size" className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="buy-size" className="text-body font-medium text-tx">
              How big it is
            </h3>
            <Button
              variant="qt"
              size="sm"
              aria-expanded={allSizes}
              onClick={() => setAllSizes((now) => !now)}
            >
              {allSizes ? "Hide other sizes" : "Show all sizes"}
            </Button>
          </div>
          {size && offer ? (
            <p className="text-body text-tx-2">
              {sizeLabel(size)}, {wholeUsd(offer.monthly)} a month
            </p>
          ) : (
            <p className="text-body text-tx-2">Pick a size below.</p>
          )}
          {allSizes ? (
            <div className="grid animate-rise gap-2 overflow-x-auto rounded-lg border border-line">
              <div className="px-3 pt-3">
                <Segmented
                  label="Kind of server"
                  options={FAMILIES.map(({ value, label }) => ({
                    value,
                    label,
                  }))}
                  value={family}
                  onChange={setFamily}
                />
              </div>
              <SizeTable
                sizes={catalogue.sizes}
                family={family}
                location={location}
                chosen={sizeId}
                onChoose={setSizeId}
              />
            </div>
          ) : null}
        </section>

        <BuyPanel
          template={template}
          choice={
            size && offer?.available
              ? { serverType: size.id, location: location.id }
              : null
          }
        />
      </Card.Body>
    </Card>
  );
}

/**
 * Today's charge, the terms and Buy. With no plan the answer carries the
 * Checkout address, which starts Starter's Free trial with the Server; the
 * browser goes there and comes back to the wizard. On a plan the Server is
 * charged at once and the wizard follows it from here.
 */
function BuyPanel({
  template,
  choice,
}: {
  template: TemplateSummary;
  choice: { serverType: string; location: string } | null;
}) {
  const router = useRouter();
  const termsId = useId();
  const whyId = useId();
  const [terms, setTerms] = useState(false);
  const today = useBoughtServerToday(choice);
  const buy = useBuyServer();

  const why = !choice
    ? "Pick a size that can be bought in this place."
    : !terms
      ? TICK_TERMS
      : today.error
        ? errorMessage(today.error)
        : !today.data
          ? "Working out today's charge."
          : null;
  const state = today.data?.state;

  function press() {
    if (why !== null || !choice || !today.data) return;
    buy.mutate(
      {
        ...choice,
        termsAccepted: true,
        prorationDate: today.data.prorationDate,
        returnTo: wizardHref({ templateId: template.id, path: "buy" }),
      },
      {
        onSuccess: (result) => {
          // Checkout (no plan yet) or a bank's check: the page to pay on.
          if (result.payUrl) window.location.href = result.payUrl;
          else
            router.replace(
              wizardHref({
                templateId: template.id,
                path: "buy",
                serverId: result.id,
              }),
            );
        },
      },
    );
  }

  return (
    <section
      aria-label="Price"
      className="grid gap-3 border-t border-line pt-4"
    >
      {today.data ? (
        <div className="grid animate-fade gap-1 rounded-md border border-line bg-panel-2 p-3">
          <p className="flex justify-between gap-2.5 text-body font-semibold">
            <span>Today</span>
            <span className="num">{centsUsd(today.data.today)}</span>
          </p>
          <p className="text-meta text-tx-2">{todayText(today.data)}</p>
        </div>
      ) : choice && !today.error ? (
        <Skeleton className="h-16" />
      ) : null}
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={termsId}
          checked={terms}
          onCheckedChange={(next) => setTerms(next === true)}
        />
        <label htmlFor={termsId} className="text-meta text-tx-2">
          I accept Octabyte&rsquo;s terms and acceptable-use policy. Octabyte is
          not responsible for lost data or machines, whatever the cause, and I
          keep my own backups.
        </label>
      </div>
      <div className="grid justify-items-start gap-1.5">
        <SubmitButton
          type="button"
          pending={buy.isPending}
          disabled={why !== null}
          aria-describedby={whyId}
          onClick={press}
        >
          {state === "start-trial" ? "Buy and start free trial" : "Buy server"}
        </SubmitButton>
        <p
          id={whyId}
          role="status"
          className={cn("text-meta", buy.error ? "text-bad" : "text-tx-3")}
        >
          {buy.error ? errorMessage(buy.error) : why}
        </p>
      </div>
      <BuyNote tone="bad">
        Deleting a server you bought deletes its data and backups, and
        can&rsquo;t be undone. If a payment fails, the server is deleted 7 days
        later.
      </BuyNote>
    </section>
  );
}
