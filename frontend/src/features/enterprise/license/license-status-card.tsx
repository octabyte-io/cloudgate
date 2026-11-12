import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

import { LICENSED_FEATURE_LIST } from "../licensed-features";
import { FIRST_WARNING_DAYS } from "./license-expiry";
import type { useLicenseStatus } from "../use-license";

/**
 * Whether the licensed features are unlocked here, right now.
 *
 * **Nothing here states the answer until there is one.** The first version rendered
 * the unlicensed sentence and four padlocks while the request was in flight, on a
 * licensed Organization — F07's `CountTile` defect exactly: a confident claim made
 * because a read has not come back yet, in the most confident position on the
 * screen. `licensed` is `false` for two different reasons and only one of them is a
 * fact, which is what `settled` separates.
 *
 * **The expiry is shown, and used to be declared unknowable.** `GET /license/status`
 * reports `validUntil`, `status` and `features` alongside the derived `licensed`
 * (it used to answer a
 * bare boolean). The sentence that change left behind said "no route reports
 * the date, so this screen cannot warn you in advance", which was rendered to
 * operators as a fact about their own instance for as long as it was false
 * `ExpiryNote` below prints the date the card already holds.
 *
 * What has *not* changed is the half of that sentence worth keeping: expiry stays
 * derived at read time, so a licence lapses with nothing written to the row.
 * `status` is still `active` on a lapsed licence and `licensed` is already `false`,
 * which is why the chip and the stored status disagree — and why the date is the
 * only thing that explains the disagreement.
 */
export function LicenseStatusCard({
  status,
}: {
  status: ReturnType<typeof useLicenseStatus>;
}) {
  const licensed = status.data?.licensed === true;
  /** Whether the question has an answer yet. */
  const settled = !status.isPending && !status.error;

  return (
    <Card aria-busy={status.isPending || undefined}>
      <Card.Header
        title="This Organization"
        sub="Whether the licensed features are unlocked here, right now."
        headingLevel={2}
        actions={
          status.isPending ? (
            <Skeleton className="h-chip w-24" />
          ) : status.error ? null : licensed ? (
            <Chip variant="brand">Licensed</Chip>
          ) : (
            <Chip>Not licensed</Chip>
          )
        }
      />
      <Card.Body className="grid gap-3.5">
        {status.isPending ? (
          <Skeleton className="h-4.5 w-3/4" />
        ) : status.error ? (
          /*
            Two sentences, and the second one is `errorMessage()`'s (H-48).
            This branch answered the first alone for **every** error and imported
            no `errorMessage` at all, which is H-37's complaint of
            `domain-gate-switch.tsx`: the backend's own account of what happened
            was thrown away, so a stopped backend, a 500 and a **banned**
            operator were all told the same nothing. `GET /license/status` is
            open to any member, so the ban is the refusal it can actually see —
            and the ban has a move to name.

            The first sentence stays, and stays first, because it answers *this
            card's* question — whether the licensed features are unlocked here —
            which `errorMessage()` has no way to know it was asked. §3.5 forbids
            rendering `ApiError.message`; it does not forbid saying what could
            not be read.
          */
          <div className="grid gap-1.5">
            <p className="text-body wrap-anywhere text-tx">
              Cloudgate could not read whether this Organization is licensed.
            </p>
            <p className="text-meta wrap-anywhere text-tx-2">
              {errorMessage(status.error)}
            </p>
          </div>
        ) : (
          <p className="text-body text-tx-2">
            {licensed
              ? /*
                  The count is derived, never written down. It said "the
                  five licensed sections below" above a list of four for as long
                  as the fifth — audit log filtering — had been removed from the
                  list, which is what the opening clause already accounts for.
                  The list is `LICENSED_FEATURES`, the registry every gate names
                 so neither the count nor the unlicensed sentence can
                  name fewer features than the gates refuse.
                */
                `Audit log filtering aside, all ${counted(
                  LICENSED_FEATURE_LIST.length,
                  "licensed feature",
                  "licensed features",
                )} below are open to this Organization.`
              : "None of the features below is open to this Organization until a license is activated here."}
          </p>
        )}

        <ul className="grid gap-1.5">
          {LICENSED_FEATURE_LIST.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2">
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4.5 flex-none items-center justify-center rounded-sm border",
                  settled && licensed
                    ? "border-ok-line bg-ok-tint text-ok"
                    : "border-line bg-panel-2 text-tx-3",
                )}
              >
                {settled ? (
                  <Icon name={licensed ? "check" : "lock"} size={11} />
                ) : null}
              </span>
              <span className="min-w-0 text-ui text-tx-2">
                <span className="font-medium text-tx">{entry.label}</span>
                {settled ? (
                  <span className="sr-only">
                    {licensed ? " — unlocked" : " — locked"}
                  </span>
                ) : null}{" "}
                — {entry.what}
              </span>
            </li>
          ))}
        </ul>

        <ExpiryNote
          settled={settled}
          validUntil={status.data?.validUntil ?? null}
        />
      </Card.Body>
    </Card>
  );
}

/**
 * Whether an expiry has already passed.
 *
 * Module scope, matching `grantState` in `provider-spec.tsx` and the clock reads
 * in `lib/format/time.ts`: `react-hooks/purity` rejects a `Date.now()` written
 * inside a component body and does not follow it through a call, so this is
 * where the tree keeps one.
 *
 * **That is a convention, not a purity claim**, and saying otherwise would be a
 * record that is wrong about its own code: `ExpiryNote` calls this during render,
 * so the clock is still read on every render and a re-render either side of the
 * expiry instant flips the answer. Which is tolerable here, and not for the
 * reason the placement suggests — the backend has already derived the same
 * comparison into `licensed`, so the chip has flipped whatever this says. All
 * that changes is which sentence explains it, and `useLicenseStatus` refetches
 * on a 30-second `staleTime` anyway.
 */
function hasLapsed(validUntil: string): boolean {
  return Date.parse(validUntil) <= Date.now();
}

/**
 * When this licence runs out, or that none of it is recorded.
 *
 * Three sentences rather than one, because there are three different facts:
 * a date that has passed, a date that has not, and no date at all. Earlier
 * all three got a fourth sentence that was true of none of them — that no route
 * reports the expiry.
 *
 * **The stamp is exact rather than relative.** `timeAgo` is the console's usual
 * choice and is the wrong one here: an expiry is a contractual instant somebody
 * puts in a calendar or matches against an invoice, and "in 3 months" is not
 * something either can be done with. The precision is also what makes the lapsed
 * case legible — a licence that ran out this morning and one that ran out in
 * March both read "earlier today" and "March" otherwise.
 *
 * Nothing is claimed while `settled` is false: the generic sentence is about
 * licences, not about this Organization, which is the same rule the card's own
 * docblock states for the padlocks.
 */
function ExpiryNote({
  settled,
  validUntil,
}: {
  settled: boolean;
  /** ISO-8601, or `null` when the licence carries no expiry. */
  validUntil: string | null;
}) {
  if (!settled) {
    return (
      <p className="text-meta text-tx-3">
        A license can also lapse on its own. Expiry is compared to the clock each
        time it is read, so nothing writes to the record when it runs out.
      </p>
    );
  }

  if (validUntil === null) {
    return (
      <p className="text-meta text-tx-3">
        No expiry date is recorded for this Organization, so nothing here lapses
        on its own. A license that carries one is compared to the clock each time
        it is read, and nothing is written to the record when it runs out.
      </p>
    );
  }

  const lapsed = hasLapsed(validUntil);

  return (
    <p className="text-meta text-tx-2">
      {lapsed ? "This license lapsed on " : "This license runs until "}
      <time dateTime={validUntil} className="font-medium text-tx">
        {timeExact(validUntil)}
      </time>
      .{" "}
      {lapsed
        ? "Expiry is compared to the clock each time it is read, so nothing was written to the record when it ran out — the stored status is still Active, and this date is the only signal that it is not."
        : `Owners and admins see a bar across the console from ${FIRST_WARNING_DAYS} days before this date, and Cloudgate re-checks the key each day from then, so a renewal arrives without pasting the key again.`}
    </p>
  );
}
