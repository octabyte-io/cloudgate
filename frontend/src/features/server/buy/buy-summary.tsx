import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { BuyChoice, TodayView } from "@/lib/api/endpoints/bought-servers";
import { formatDay } from "@/lib/api/endpoints/billing";
import { errorMessage } from "@/lib/api/error-message";

import { BuyNote } from "./buy-note";
import { wholeUsd } from "./buy-model";
import { useBoughtServerToday, useBuyServer } from "./use-bought-servers";

export type SummaryLine = { label: string; monthly: number };

export const TICK_TERMS = "Tick the box to accept the terms.";

/** US cents as dollars and cents: `$15.20`. */
export function centsUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The Add-on's summary line: what it adds, and how many for more than one. */
export function addOnLabel(quantity: number): string {
  return quantity === 1
    ? "Add-on: room for 1 more Server"
    : `${quantity} Add-ons: room for ${quantity} more Servers`;
}

/**
 * The lines the plan state adds beside the Server's own (#1392): the plan
 * Checkout starts, with no plan, and the Add-on a full Server count needs.
 * Whole dollars, like the Server's lines.
 */
function planLines(today: TodayView | undefined): SummaryLine[] {
  if (!today) return [];
  const lines: SummaryLine[] = [];
  if (today.plan) {
    lines.push({
      label: `${today.plan.name} plan`,
      monthly: today.plan.monthlyCents / 100,
    });
  }
  if (today.addOn) {
    lines.push({
      label: addOnLabel(today.addOn.quantity),
      monthly: (today.addOn.monthlyCents * today.addOn.quantity) / 100,
    });
  }
  return lines;
}

/**
 * The summary that stays in view (layout A): a price line for the Server
 * and each extra, with the plan and an Add-on when the plan state brings
 * them, the monthly total, the Today box, the terms box, **Buy**, and the
 * deletion warning ADR-0071 puts beside it.
 *
 * Buying works whatever the plan state (#1392): with no plan, Buy goes on
 * to Checkout, which starts Starter (in its Free trial when that is
 * available); a full Server count adds an Add-on, with a note saying why.
 * A Buy that can't be pressed says why: what is still to pick first, then
 * the terms box. Pressed on a plan, it charges at once; the purchase then
 * shows under Servers, waiting for payment (3D Secure) or being made.
 */
export function BuySummary({
  lines,
  missing,
  choice,
}: {
  lines: SummaryLine[];
  /** What the customer still has to pick or fix, or null once the choice can be bought. */
  missing: string | null;
  /** The size and Location, and backups and extra storage when chosen, once the size can be bought there. */
  choice: BuyChoice | null;
}) {
  const router = useRouter();
  const termsId = useId();
  const [terms, setTerms] = useState(false);
  const today = useBoughtServerToday(missing === null ? choice : null);
  const buy = useBuyServer();

  const shown = lines.length > 0 ? today.data : undefined;
  const allLines = [...lines, ...planLines(shown)];
  const total = allLines.reduce((sum, line) => sum + line.monthly, 0);
  const why =
    missing ??
    (terms ? null : TICK_TERMS) ??
    (today.error
      ? errorMessage(today.error)
      : !today.data
        ? "Working out today's charge."
        : null);
  const state = today.data?.state;
  const checkout = state === "start-trial" || state === "start-plan";

  function press() {
    if (why !== null || !choice || !today.data) return;
    buy.mutate(
      {
        ...choice,
        termsAccepted: true,
        prorationDate: today.data.prorationDate,
      },
      {
        onSuccess: (result) => {
          // With no plan, the plan starts in Checkout; the Server waits for it.
          if (checkout && result.payUrl) window.location.href = result.payUrl;
          else router.push("/servers");
        },
      },
    );
  }

  return (
    <Card className="cols:sticky cols:top-4">
      <Card.Header title="Summary" headingLevel={2} />
      <Card.Body className="grid gap-3">
        {lines.length === 0 ? (
          <p className="text-ui text-tx-3">Pick a location and a size.</p>
        ) : (
          <dl className="grid gap-1.5 text-ui">
            {allLines.map((line) => (
              <div key={line.label} className="flex justify-between gap-2.5">
                <dt className="text-tx-2">{line.label}</dt>
                <dd className="num text-tx">{wholeUsd(line.monthly)}</dd>
              </div>
            ))}
            <div className="mt-1 flex justify-between gap-2.5 border-t border-line pt-2 text-body font-semibold">
              <dt>Total per month</dt>
              <dd className="num">{wholeUsd(total)}</dd>
            </div>
          </dl>
        )}
        {shown?.addOn ? (
          <p className="text-meta text-tx-2">{addOnNote(shown)}</p>
        ) : null}
        {shown ? <TodayBox today={shown} /> : null}
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={termsId}
            checked={terms}
            onCheckedChange={(next) => setTerms(next === true)}
          />
          <label htmlFor={termsId} className="text-meta text-tx-2">
            I accept Octabyte&rsquo;s terms and acceptable-use policy. Octabyte
            is not responsible for lost data or machines, whatever the cause,
            and I keep my own backups.
          </label>
        </div>
        <div className="grid gap-1.5">
          <Button
            variant="pri"
            disabled={why !== null || buy.isPending}
            aria-describedby="buy-why"
            onClick={press}
          >
            {state === "start-trial" ? "Buy and start Free trial" : "Buy"}
          </Button>
          <p id="buy-why" className="text-meta text-tx-3">
            {buy.error ? errorMessage(buy.error) : why}
          </p>
        </div>
        <BuyNote tone="bad">
          Deleting a Bought Server deletes its data and backups, and can&rsquo;t
          be undone. If a payment fails, your Bought Servers are deleted 7 days
          later.
        </BuyNote>
      </Card.Body>
    </Card>
  );
}

/** Why an Add-on is in the summary: the Server count is full. */
export function addOnNote(today: TodayView): string {
  const addOn = today.addOn;
  if (!addOn) return "";
  const added =
    addOn.quantity === 1
      ? "an Add-on is added with this one"
      : `${addOn.quantity} Add-ons are added with this one`;
  const when =
    today.state === "trial" || today.state === "start-trial"
      ? "Like the plan, it costs nothing until the Free trial ends."
      : "It is part of today's charge.";
  return `Your Server count is full, so ${added} (room for 1 more Server, ${wholeUsd(addOn.monthlyCents / 100)}/month each). ${when}`;
}

/** The day of a Unix time in seconds. */
function day(seconds: number): string {
  return formatDay(new Date(seconds * 1000));
}

/** What Buy charges now, the dates it covers, and what comes after. */
function TodayBox({ today }: { today: TodayView }) {
  return (
    <div
      aria-label="Today"
      className="grid animate-fade gap-1 rounded-md border border-line bg-panel-2 p-2.5"
    >
      <p className="flex justify-between gap-2.5 text-body font-semibold">
        <span>Today</span>
        <span className="num">{centsUsd(today.today)}</span>
      </p>
      <p className="text-meta text-tx-2">{todayText(today)}</p>
    </div>
  );
}

/** The Today box's sentence, for each plan state. */
export function todayText(today: TodayView): string {
  const monthly = centsUsd(today.monthly);
  const plan = today.plan?.name ?? "Starter";
  const to = today.to ?? today.from;
  switch (today.state) {
    case "plan":
      return `${
        today.to !== null
          ? `For ${day(today.from)} to ${day(today.to)}, when your plan renews. `
          : ""
      }Then ${monthly} a month more.`;
    case "trial":
      return `The Free trial covers your plan, not the Server, so the Server is charged on its own invoice for ${day(today.from)} to ${day(to)}, when the trial ends. Then it joins your plan's monthly invoice at ${monthly} a month.`;
    case "start-trial":
      return `Starts the ${plan} Free trial, free until ${day(to)}. The trial covers ${plan}, not the Server, so the Server is charged today to the trial's end. Then ${monthly} a month.`;
    case "start-plan":
      return `${plan} (${centsUsd(today.plan?.todayCents ?? 0)}) and the Server are both paid today, for the month ahead. Then ${monthly} a month more for the Server.`;
  }
}
