import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { isApiError } from "@/lib/api/api-error";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { Icon } from "@/lib/design/icons";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { ComesWithBusiness } from "./business-plan";
import type { LicensedFeatureId } from "./licensed-features";
import { useFeatureLicensed } from "./use-feature-licensed";

/**
 * Which entry (or entries) of `LICENSED_FEATURES` a gate stands for.
 * Required on both gates, so the License screen's list of what a licence
 * unlocks is the list of what the gates refuse — `licensed-features.test.ts`
 * holds the census.
 */
export type GatedFeature = LicensedFeatureId | readonly LicensedFeatureId[];

function featureIds(feature: GatedFeature): string {
  return typeof feature === "string" ? feature : feature.join(" ");
}

/**
 * **The one gate, and the one sentence, for every licensed section.**
 *
 * `GET /license/status` decides what four of the five Enterprise screens are
 * allowed to render, and it is the *only* honest way to decide: their own reads
 * answer `403 Valid enterprise license required`, and a 403 means "your role
 * does not allow this" to F02's status rules — which is exactly the wrong
 * sentence here. Nothing about the reader's role is the problem. So the gate
 * asks the question the backend will actually ask, once, and the sections
 * beneath it never make a request that was always going to be refused.
 *
 * ## Why this is not `--hatch` and must not look like it
 *
 * The prototype's hatch means **"does not exist yet"**. This means "it exists,
 * it works, and this Organization has not bought it" — a different statement
 * with a different action attached, and a screen that used the same treatment
 * for both would teach the reader that neither is worth reading. So:
 *
 * - It says what the feature **is**, in a sentence, before it says anything
 *   about the licence. Somebody arriving here has usually never seen the
 *   feature, and "requires a licence" alone tells them nothing about whether
 *   they want one.
 * - It says the licence does not cover it, plainly, once.
 * - It offers the **one** thing that changes the answer: the License screen.
 * - It renders **nothing of the feature** — no greyed table, no disabled form.
 *   A form you cannot submit invites you to fill it in, and an empty table
 *   claims your Organization has none of something it cannot be asked about.
 *
 * ## The three states before the gate even applies
 *
 * `undefined` while the read is in flight is a skeleton, not a locked screen —
 * F07's `CountTile` defect in another form: rendering the refusal while the
 * question is unanswered is a confident claim made because a request has not
 * come back yet.
 *
 * A **failed** status read is its own state and not a locked one. It is a
 * refusal about `GET /license/status`, which every member may call, so a failure
 * there means something else is wrong — and saying "no licence" would be
 * inventing an answer from a missing one. *
 * ## Kept but stopped
 *
 * Below the paid features the settings an Organization made on Business (or
 * under a license) are kept, and their reads stay open. So "renders nothing
 * of the feature" is right only for a feature **never set up**. A section
 * that can tell the two apart passes `useKept`, a hook (a module-level
 * function, so the same one every render) answering whether anything is kept:
 * then an unlicensed gate renders `content` when something is, and `content`
 * shows it read-only under `KeptStoppedStrip` (`useKeptStopped`), and the
 * lock when nothing is. A read refused for the reader's role (a member, on a
 * page whose reads are owner-or-admin) is the lock too, worded for a member.
 */
export interface KeptReading {
  isPending: boolean;
  error: unknown;
  /** Whether this Organization has settings for the feature to keep. */
  kept: boolean;
}

export function LicenseGate({
  /** The registry entry this gate refuses — see `GatedFeature`. */
  feature,
  /** What the section is called. Used in the heading, so it reads as its own. */
  title,
  /** One sentence saying what the feature does, in plain words. */
  children,
  /** The section itself, rendered once the licence covers it. */
  content,
  /** Whether settings are kept to show read-only when it does not; see above. */
  useKept,
}: {
  feature: GatedFeature;
  title: string;
  children: React.ReactNode;
  content: React.ReactNode;
  useKept?: () => KeptReading;
}) {
  const status = useFeatureLicensed(feature);

  if (status.licensed) return <>{content}</>;

  if (status.isPending) return <SectionPending title={title} rows={3} />;

  if (status.error) {
    return (
      <SectionFailed title={title} error={status.error}>
        Cloudgate could not find out whether this Organization is licensed, so
        it is not guessing. Every member of an Organization may read that, so
        this is not about your role.
      </SectionFailed>
    );
  }

  const locked = (
    <Card>
      <Card.Header title={title} headingLevel={2} />
      <Card.Body>
        <LicenseLocked feature={feature}>{children}</LicenseLocked>
      </Card.Body>
    </Card>
  );

  if (!useKept) return locked;
  return (
    <KeptOrLocked
      useKept={useKept}
      title={title}
      content={content}
      locked={locked}
    />
  );
}

/** The unlicensed gate of a section that keeps settings. */
function KeptOrLocked({
  useKept,
  title,
  content,
  locked,
}: {
  useKept: () => KeptReading;
  title: string;
  content: React.ReactNode;
  locked: React.ReactNode;
}) {
  const kept = useKept();

  if (kept.isPending) return <SectionPending title={title} rows={3} />;
  if (kept.error) {
    // A member may not read these settings at all: what they need is who can
    // change the plan, which the lock says.
    if (isApiError(kept.error) && kept.error.isForbidden) return <>{locked}</>;
    return (
      <SectionFailed title={title} error={kept.error}>
        Cloudgate could not read what this Organization has set up here, so it
        is not guessing whether anything is kept.
      </SectionFailed>
    );
  }
  return <>{kept.kept ? content : locked}</>;
}

/**
 * **The sentence itself, without the card around it.**
 *
 * `LicenseGate` is the right shape when a whole section has nothing to show
 * unlicensed. One screen is not in that position: `GET /custom-roles` is open,
 * so an Organization whose licence has lapsed can still *see* the roles it
 * defined — and seeing them is the most useful thing that screen can do in that
 * state, because anyone holding one is currently denied every action
 * Hiding the list
 * behind the gate would hide the problem.
 *
 * So the block is separable, and there is still exactly **one** place the
 * wording lives. A second hand-written "you need a licence" paragraph is how two
 * screens end up describing the same condition two ways.
 */
export function LicenseLocked({
  feature,
  children,
}: {
  /** The registry entry this refusal is about — see `GatedFeature`. */
  feature: GatedFeature;
  children: React.ReactNode;
}) {
  const mode = useInstanceMode();

  // Neither sentence until the mode is known: a Hosted customer must not be
  // shown a license, even for a moment.
  if (mode.isPending) {
    return <div data-licensed-feature={featureIds(feature)} />;
  }

  return (
    <div className="flex gap-3" data-licensed-feature={featureIds(feature)}>
      <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-md border border-info-line bg-info-tint text-info">
        <Icon name="lock" size={15} />
      </span>
      <div className="min-w-0">
        {mode.data === "hosted" ? (
          <ComesWithBusiness feature={feature} />
        ) : (
          <>
            <p className="text-body text-tx">{children}</p>
            <LicenseOnly />
          </>
        )}
      </div>
    </div>
  );
}

function LicenseOnly() {
  return (
    <>
      <p className="mt-1.5 text-meta text-tx-2">
        Your enterprise license does not cover it. Nothing here is switched off
        for your role — the feature is built and working, and this Organization
        has not activated a license for it.
      </p>
      <div className="mt-3">
        <LinkButton href="/settings/license" size="sm">
          Go to License
        </LinkButton>
      </div>
    </>
  );
}
