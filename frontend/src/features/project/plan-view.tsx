import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  Plan,
  PlanConfirmation,
  PlanStep,
} from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

import {
  awsWaitLine,
  driftOf,
  isDriftOnly,
  isQuiet,
  planTotals,
  putsBackOnly,
  readsAws,
  totalsLine,
} from "./plan-aws";
import { ConfirmByName } from "./plan-confirm";
import {
  confirmKey,
  confirmWord,
  DestroysSection,
  type Destroy,
} from "./plan-destroys";
import { PlanCloudName } from "./plan-aws-lines";
import { DriftSection } from "./plan-drift";
import { NotesSection } from "./plan-notes";
import { HeldBuildRow, ResultRow } from "./plan-result-row";
import { ExistingLookups, isLookupOnly } from "./plan-existing";
import { PlanSection as Section } from "./plan-section";
import { StepRow } from "./plan-step-row";

/**
 * One Environment's Plan (US19, US25): what applying the Project config
 * would create, change and destroy there, each change with the fields it
 * changes, and the notes that change nothing.
 *
 * **Destroys are their own section, in red.** A destroy is the existing
 * Delete, and a rename or a kind change in the config is one too (a destroy
 * plus a create under the same Config name), so the section an operator must
 * not skim past is the one that looks different.
 *
 * **An applied plan leads with what happened**: each step's result in
 * the order it ran, the Domain a created `web` got, and a link to the
 * Deployment it queued — a failed build is that Deployment's, not the
 * plan's, so the plan only reports what it wrote.
 *
 * **Apply sits under the destroys, and asks for each destroyed Service's
 * name first** (US25). Each destroy is the Delete an operator already
 * knows, so it is confirmed the way Delete is, by typing the Service's name;
 * Apply stays disabled until every one matches, and sends their Config names
 * as `confirmDestroy`. A destroy's result names what its Delete left behind.
 * A bucket's destroy says whether it holds files and offers "also delete the
 * files" for that one bucket, sent as `deleteFilesOf`. A cloud
 * database's says the final snapshot it keeps and offers "also delete its
 * data (no final snapshot)", sent as `deleteDataOf`.
 *
 * **A major upgrade is shown apart and confirmed the same way**: a
 * database's new major version is offline while it runs and never undone,
 * so its change sits in its own section above the destroys, with its outage
 * line, and its Service's name is typed too, sent as `confirmUpgrade`.
 *
 * **Held builds**: a push plan lists the builds the same push held for
 * it, each with its status now and, while held, "Build now with saved
 * settings".
 *
 * **A cloud plan reads AWS** (following `prototype/cloud-plan-view`):
 * a totals strip leads, "N create · N change · N destroy · N drift ·
 * N brief downtime"; each cloud step shows its plain summary, always open,
 * with the raw AWS lines folded under "Show N AWS resources", or "reading
 * AWS…" while its read runs, or why it failed. Until every read succeeds,
 * Apply is greyed out with a line naming what it waits on: there is no
 * partial Apply.
 *
 * **Drift is its own amber section**, after the Destroys and before
 * Apply: what was changed by hand in the AWS console, field by field, which
 * Apply puts back; red where only a replace does, with brief downtime. A
 * cloud Service or network read only for Drift is not a change of its own:
 * read and found as Cloudgate made it, it is not shown at all, and a plan
 * that only puts AWS back says so on its button, "Apply: put AWS back".
 * What a tag search found that no state wants is a note.
 *
 * **A plan a deploy stopped on names it**: a cloud Service's deploy
 * that met more than its new image left its whole plan open. The plan leads
 * with which deploy, links to it, and marks the step it stopped on.
 *
 * `serverNames` names a Server placement and `cloudAccountNames` a Cloud
 * account; an id they lack is shown as it is. `cloudName` is the cloud the
 * plan reads, as its lines name it: "Google Cloud" on a Google Deploy
 * target, "AWS" unless said. `onApply`, when given, offers
 * Apply on an open plan.
 */
type Change = Extract<
  PlanStep,
  { action: "change" | "network-change" | "redeploy" }
>;

/** A major upgrade, confirmed by name as a destroy is. */
type Upgrade = Extract<PlanStep, { action: "change" }>;

export function PlanView({
  plan,
  serverNames = {},
  cloudAccountNames = {},
  onApply,
  applying = false,
  applyHint,
  cloudName = "AWS",
}: {
  plan: Plan;
  serverNames?: Readonly<Record<string, string>>;
  cloudAccountNames?: Readonly<Record<string, string>>;
  cloudName?: string;
  onApply?: (confirm: PlanConfirmation) => void;
  applying?: boolean;
  applyHint?: string;
}) {
  const creates = plan.steps.filter(
    (step) => step.action === "create" || step.action === "network-create",
  );
  // A Drift check shows under Changes only for what it found beyond Drift.
  const changes = plan.steps.filter(
    (step): step is Change =>
      ((step.action === "change" || step.action === "network-change") &&
        !isQuiet(step) &&
        !isDriftOnly(step) &&
        !isLookupOnly(step) &&
        !(step.action === "change" && step.majorUpgrade)) ||
      step.action === "redeploy",
  );
  const upgrades = plan.steps.filter(
    (step): step is Upgrade => step.action === "change" && !!step.majorUpgrade,
  );
  const drift = driftOf(plan);
  const nothing = plan.steps.every(isQuiet);
  const destroys = plan.steps.filter(
    (step): step is Destroy =>
      step.action === "destroy" || step.action === "network-remove",
  );
  // Keyed by plan, so a newer plan never inherits a name typed for an older one.
  const [typed, setTyped] = useState<{
    planId: string;
    names: Readonly<Record<string, string>>;
  }>({ planId: plan.planId, names: {} });
  const names = typed.planId === plan.planId ? typed.names : {};
  const matches = (step: Destroy | Upgrade) =>
    step.action === "change"
      ? names[step.configName]?.trim() === step.name
      : names[confirmKey(step)]?.trim() === confirmWord(step);
  const type = (key: string, value: string) =>
    setTyped({
      planId: plan.planId,
      names: { ...names, [key]: value },
    });
  // The ticked buckets and cloud databases, keyed by plan for the same reason.
  const [ticked, setTicked] = useState<{
    planId: string;
    names: ReadonlySet<string>;
  }>({ planId: plan.planId, names: new Set() });
  const deleteFilesOf =
    ticked.planId === plan.planId ? ticked.names : new Set<string>();
  const tick = (configName: string, checked: boolean) => {
    const next = new Set(deleteFilesOf);
    if (checked) next.add(configName);
    else next.delete(configName);
    setTicked({ planId: plan.planId, names: next });
  };
  const confirming = onApply !== undefined && plan.status === "open";
  const confirmed = destroys.every(matches) && upgrades.every(matches);
  const waiting = awsWaitLine(plan, cloudName);
  const stopped = plan.stoppedDeployment ?? null;

  return (
    <PlanCloudName value={cloudName}>
      <div className="grid gap-4">
        {stopped ? (
          <p
            aria-label="Opened by a stopped deploy"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-tx-2"
          >
            <Icon name="alert" className="flex-none text-warn" />
            <span>
              A deploy of{" "}
              <span className="font-mono font-medium text-tx">
                {stopped.configName}
              </span>{" "}
              ({stopped.title}, {new Date(stopped.createdAt).toLocaleString()})
              stopped on this plan: {cloudName} differs from what Cloudgate
              made.
            </span>
            <Link
              href={`/applications/${stopped.applicationId}/deployments`}
              className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
            >
              Its Deployment →
            </Link>
          </p>
        ) : null}

        {readsAws(plan) ? (
          <p aria-label="Totals" className="font-mono text-meta text-tx-2">
            {totalsLine(planTotals(plan))}
          </p>
        ) : null}

        {plan.results ? (
          <Section title="Results">
            {plan.results.length === 0 ? (
              <p className="text-body text-tx-3">Nothing was run.</p>
            ) : (
              plan.results.map((result) => (
                <ResultRow
                  key={`${result.action}-${result.configName}`}
                  result={result}
                />
              ))
            )}
          </Section>
        ) : null}

        {plan.heldBuilds && plan.heldBuilds.length > 0 ? (
          <Section title="Held builds">
            <p className="text-meta text-tx-3">
              The push that made this plan changed these Applications&apos; code
              and their own config entries, so their builds wait for this plan:
              Apply builds them with its settings, Dismiss with the saved ones.
            </p>
            {plan.heldBuilds.map((build) => (
              <HeldBuildRow key={build.deploymentId} build={build} />
            ))}
          </Section>
        ) : null}

        {nothing ? (
          <p className="flex items-center gap-2 text-body text-tx-2">
            <Icon name="check" className="text-ok" />
            <span className="font-medium text-tx">Nothing to change</span>
            <span className="text-tx-3">
              — the config says what this Environment already has.
            </span>
          </p>
        ) : null}

        {creates.length > 0 ? (
          <Section title="Creates">
            {creates.map((step) => (
              <StepRow
                key={
                  step.action === "network-create"
                    ? `network-${step.cloudAccountId}-${step.region}`
                    : `create-${step.configName}`
                }
                step={step}
                serverNames={serverNames}
                cloudAccountNames={cloudAccountNames}
                environmentId={confirming ? plan.environmentId : undefined}
              />
            ))}
          </Section>
        ) : null}

        <ExistingLookups plan={plan} />

        {changes.length > 0 ? (
          <Section title="Changes">
            {changes.map((step) => (
              <StepRow
                key={
                  step.action === "network-change"
                    ? `network-${step.environmentNetworkId}`
                    : `change-${step.configName}`
                }
                step={step}
                serverNames={serverNames}
                cloudAccountNames={cloudAccountNames}
                stopped={
                  step.action === "change" &&
                  stopped?.configName === step.configName
                    ? stopped
                    : undefined
                }
              />
            ))}
          </Section>
        ) : null}

        {upgrades.length > 0 ? (
          <Section
            title="Major upgrades"
            className="rounded-lg border border-warn-line bg-warn-tint p-3 text-warn"
          >
            <p className="text-meta">
              A postgres is offline while it upgrades and a redis may drop
              connections briefly; an upgrade cannot be undone.
            </p>
            {upgrades.map((step) => (
              <div key={`upgrade-${step.configName}`} className="grid gap-2">
                <p className="text-body font-medium">
                  {step.configName}: {step.majorUpgrade?.from} →{" "}
                  {step.majorUpgrade?.to}
                </p>
                <StepRow step={step} serverNames={serverNames} />
                {confirming ? (
                  <ConfirmByName
                    confirmKey={step.configName}
                    word={step.name}
                    value={names[step.configName] ?? ""}
                    matches={matches(step)}
                    onChange={(value) => type(step.configName, value)}
                  />
                ) : null}
              </div>
            ))}
          </Section>
        ) : null}

        {destroys.length > 0 ? (
          <DestroysSection
            destroys={destroys}
            serverNames={serverNames}
            cloudAccountNames={cloudAccountNames}
            confirming={confirming}
            typed={names}
            matches={matches}
            onType={type}
            ticked={deleteFilesOf}
            onTick={tick}
          />
        ) : null}

        {drift.length > 0 ? <DriftSection entries={drift} /> : null}

        {confirming ? (
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {waiting ? (
              <span className="max-w-[60ch] text-right text-meta text-tx-3">
                {waiting}
              </span>
            ) : null}
            <Button
              variant={
                destroys.length > 0 || upgrades.length > 0 ? "dngr" : "pri"
              }
              disabled={!confirmed || applying || waiting !== null}
              aria-busy={applying || undefined}
              title={applyHint}
              onClick={() => {
                if (confirmed && !applying && waiting === null) {
                  onApply({
                    destroy: destroys.map(confirmKey),
                    upgrade: upgrades.map((step) => step.configName),
                    deleteFilesOf: destroys
                      .filter(
                        (step) =>
                          step.action === "destroy" &&
                          step.kind === "bucket" &&
                          deleteFilesOf.has(step.configName),
                      )
                      .map(confirmKey),
                    deleteDataOf: destroys
                      .filter(
                        (step) =>
                          step.action === "destroy" &&
                          step.finalSnapshot !== undefined &&
                          deleteFilesOf.has(step.configName),
                      )
                      .map(confirmKey),
                  });
                }
              }}
            >
              {putsBackOnly(plan) ? `Apply: put ${cloudName} back` : "Apply"}
            </Button>
          </div>
        ) : null}

        <NotesSection plan={plan} />
      </div>
    </PlanCloudName>
  );
}
