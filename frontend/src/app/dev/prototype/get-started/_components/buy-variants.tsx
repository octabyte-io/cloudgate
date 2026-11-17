"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Button } from "@/components/ui/button";
import {
  sizeLabel,
  storageMonthly,
  wholeUsd,
} from "@/features/server/buy/buy-model";
import { BuySummary } from "@/features/server/buy/buy-summary";
import { ExtrasCard } from "@/features/server/buy/extras-card";
import { LocationCards } from "@/features/server/buy/location-cards";

import {
  FamilySizes,
  ImageField,
  SuggestionPicks,
  imageLabel,
  placeName,
  useBuyChoice,
} from "./buy-parts";
import type { BuyState } from "./buy-parts";
import { CATALOGUE } from "./fixtures";

function Extras({ buy }: { buy: BuyState }) {
  return (
    <ExtrasCard
      backups={buy.backups}
      onBackups={buy.setBackups}
      backupsMonthly={buy.offer?.backupsMonthly ?? null}
      storageGb={buy.storageGb}
      onStorageGb={buy.setStorageGb}
      storage={CATALOGUE.storage}
    />
  );
}

function Summary({ buy }: { buy: BuyState }) {
  return <BuySummary lines={buy.lines} missing={buy.missing} choice={buy.choice} />;
}

/**
 * A: the Buy a Server screen's own two columns, inside the wizard. Every
 * option on the left as a numbered card, the suggestions first; the
 * summary, today's charge, the terms and Buy in the sticky rail on the
 * right. One column on a phone, the summary last.
 */
export function BuyVariantA() {
  const buy = useBuyChoice();
  return (
    // Stretched, so the rail is as tall as the options and the summary's
    // own `cols:sticky` has room to stick: under `Cols`' `items-start` the
    // rail is only as tall as the card, and it scrolls away.
    <Cols
      aside={<Summary buy={buy} />}
      asideLabel="Summary"
      className="items-stretch"
    >
      <Card>
        <Card.Header
          title="Suggested for flatnotes"
          sub="The closest place it fits, and the cheapest anywhere. Or pick your own below."
          headingLevel={2}
        />
        <Card.Body>
          <SuggestionPicks buy={buy} />
        </Card.Body>
      </Card>
      <Card>
        <Card.Header title="1. Location" headingLevel={2} />
        <Card.Body>
          <LocationCards
            ordered={buy.ordered}
            chosen={buy.location.id}
            onChoose={buy.choosePlace}
          />
        </Card.Body>
      </Card>
      <Card>
        <Card.Header title={`2. Size in ${buy.location.city}`} headingLevel={2} />
        <Card.Body>
          <FamilySizes buy={buy} />
        </Card.Body>
      </Card>
      <Extras buy={buy} />
      <Card>
        <Card.Header title="4. Operating system" headingLevel={2} />
        <Card.Body>
          <ImageField buy={buy} />
        </Card.Body>
      </Card>
    </Cols>
  );
}

/** One choice as a line: what it is now, and Change, which opens it in place. */
function ChoiceRow({
  title,
  value,
  open,
  onToggle,
  children,
}: {
  title: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <h3 className="text-body font-medium text-tx">{title}</h3>
          <p className="text-ui wrap-anywhere text-tx-2">{value}</p>
        </div>
        <Button variant="qt" size="sm" aria-expanded={open} onClick={onToggle}>
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {open ? <div className="animate-rise">{children}</div> : null}
    </section>
  );
}

function extrasLine(buy: BuyState): string {
  const parts = [
    buy.backups && buy.offer ? `Backups, ${wholeUsd(buy.offer.backupsMonthly)}/month` : null,
    buy.storageGb !== null
      ? `${buy.storageGb} GB extra storage, ${wholeUsd(storageMonthly(buy.storageGb, CATALOGUE.storage.perGbMonthly))}/month`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : "No backups, no extra storage";
}

/**
 * B: one card, one line per choice, each opening in place with Change.
 * The suggestions sit at the top; the summary and Buy follow the card.
 */
export function BuyVariantB() {
  const buy = useBuyChoice();
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (row: string) => setOpen((now) => (now === row ? null : row));
  return (
    <div className="grid gap-4.5">
      <Card>
        <Card.Header
          title="Your new server"
          sub="Closest or cheapest, then change anything you like."
          headingLevel={2}
        />
        <Card.Body className="grid gap-4">
          <SuggestionPicks buy={buy} />
          <ChoiceRow
            title="Location"
            value={placeName(buy.location)}
            open={open === "where"}
            onToggle={() => toggle("where")}
          >
            <LocationCards
              ordered={buy.ordered}
              chosen={buy.location.id}
              onChoose={buy.choosePlace}
            />
          </ChoiceRow>
          <ChoiceRow
            title="Size"
            value={
              buy.size && buy.offer
                ? `${sizeLabel(buy.size)}, ${wholeUsd(buy.offer.monthly)} a month`
                : "Pick a size"
            }
            open={open === "size"}
            onToggle={() => toggle("size")}
          >
            <FamilySizes buy={buy} />
          </ChoiceRow>
          <ChoiceRow
            title="Operating system"
            value={imageLabel(buy.image)}
            open={open === "image"}
            onToggle={() => toggle("image")}
          >
            <ImageField buy={buy} />
          </ChoiceRow>
          <ChoiceRow
            title="Backups and extra storage"
            value={extrasLine(buy)}
            open={open === "extras"}
            onToggle={() => toggle("extras")}
          >
            <Extras buy={buy} />
          </ChoiceRow>
        </Card.Body>
      </Card>
      <Summary buy={buy} />
    </div>
  );
}

/**
 * C: the two suggestions are the choice. One line says what comes with
 * the picked one; Customise opens every option inline under it.
 */
export function BuyVariantC() {
  const buy = useBuyChoice();
  const [custom, setCustom] = useState(false);
  return (
    <div className="grid gap-4.5">
      <Card>
        <Card.Header
          title="Pick a server for flatnotes"
          sub="Both run flatnotes well. Customise to change the place, size, system or extras."
          headingLevel={2}
          actions={
            <Button
              variant="qt"
              size="sm"
              aria-expanded={custom}
              onClick={() => setCustom((now) => !now)}
            >
              {custom ? "Hide options" : "Customise"}
            </Button>
          }
        />
        <Card.Body className="grid gap-4">
          <SuggestionPicks buy={buy} />
          <p className="text-ui text-tx-2">
            {imageLabel(buy.image)} · {extrasLine(buy)}
          </p>
          {custom ? (
            <div className="grid animate-rise gap-5 border-t border-line pt-4">
              <section className="grid gap-2">
                <h3 className="text-body font-medium text-tx">Location</h3>
                <LocationCards
                  ordered={buy.ordered}
                  chosen={buy.location.id}
                  onChoose={buy.choosePlace}
                />
              </section>
              <section className="grid gap-2">
                <h3 className="text-body font-medium text-tx">
                  Size in {buy.location.city}
                </h3>
                <FamilySizes buy={buy} />
              </section>
              <ImageField buy={buy} />
              <Extras buy={buy} />
            </div>
          ) : null}
        </Card.Body>
      </Card>
      <Summary buy={buy} />
    </div>
  );
}
