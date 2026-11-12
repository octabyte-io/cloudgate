import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";
import { FormError } from "@/components/console/field";
import { SectionHeading } from "@/components/console/section-heading";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { useUnsavedChangesGuard } from "@/components/console/use-unsaved-changes";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import { roleRefusal, usePermission, type Gate } from "@/lib/auth/use-permission";
import { durationIssue } from "@/lib/forms/engine-units";

import { ResourceField } from "@/components/console/resource-field";
import {
  AI_MODEL_LOCKED_CONCERNS,
  CONCERN_OF_COLUMN,
  configOwnedConcerns,
  ownedConcernWords,
  swarmConcerns,
} from "./swarm-concerns";
import {
  DURATION_FIELDS,
  toSwarmColumns,
  toSwarmValues,
  type SwarmValues,
} from "./swarm-values";

/**
 * The Docker Swarm service-spec overrides — **eleven cards, one form, one Save.**
 *
 * This is the shape F10's brief asks for, and the reason is not tidiness. These
 * eleven columns are edited together or not at all: a mode change and a
 * placement constraint that disagree produce a service that never schedules, and
 * discovering that through eleven separate saves means eleven separate
 * Deployments to find out which one did it. One submit sends one `PATCH`, and
 * the whole spec is either what you meant or unchanged.
 *
 * The cards are visual grouping only — every one of them writes into the same
 * `FormProvider`, and `swarm-values.ts` folds the flat form back into the eleven
 * typed JSON columns.
 *
 * **The schema is deliberately loose**, but for the durations' unit.
 * Nearly every field here is a string that
 * folds to an optional number, and the real validation is the backend's — those
 * eleven zod schemas are `.strict()`, so a wrong shape comes back as a 400.
 * Duplicating eleven Docker Engine schemas in the browser would give two
 * definitions of correct, and the browser's would be the one that goes stale.
 *
 * **What a 400 names here is a column, not a field**. `labelsSwarm` is
 * folded out of the Labels card's key/value rows, so there is no input called
 * that and `useApiForm` has nothing to mark. Every refusal therefore used to be
 * read out under all eleven cards as "a value this form does not show", which
 * named an internal column and was wrong about the card being absent.
 * `CONCERN_OF_COLUMN` says which card owns which column, and the message is
 * shown on that card.
 *
 * **Off, with the reason, for a role the save would be refused**.
 * `PATCH /applications/:id` runs `findOwnedForUpdate` first, which asks for
 * `service: ['update']` — the statement Change source and the build's Edit read
 * on the Source tab. Save and the six row adders go off together; the fields
 * stay readable, as on a `SettingsCard` handed a `gate`.
 *
 * **An AI model is not offered what its API refuses**: its
 * Networks, Health check and Endpoint spec cards are left out, and so are
 * their columns from the save, so the platform's values are never sent back.
 *
 * **The seven `native.docker` owns are the file's on a described Service**.
 * On a Service a repository-kept config describes, Labels, the
 * restart policy, the update and rollback configs, the health check, the stop
 * grace period and ulimits are off with the file's pointer, as any
 * config-owned setting is, and left out of the save, so a Save of
 * placement, networks, ports or the mode never restates them. Only the
 * keys the kind takes are the file's (`configOwnedConcerns`): a Cron
 * service's Labels, stop grace period and ulimits are locked, and its health
 * check, restart policy, update and rollback configs stay the console's.
 */

/**
 * Loose, with one exception: a duration that is not a number of seconds is
 * refused beside its field. Folding it to nothing instead would save
 * the card with the duration silently dropped.
 */
const schema = z
  .object({})
  .passthrough()
  .superRefine((values, ctx) => {
    for (const name of DURATION_FIELDS) {
      const issue = durationIssue("This", String(values[name] ?? ""));
      if (issue) ctx.addIssue({ code: "custom", path: [name], message: issue });
    }
  }) as unknown as z.ZodType<SwarmValues>;

/** What leaving with Swarm edits unsaved asks first. */
export const SWARM_UNSAVED =
  "Your Docker Swarm changes are not saved. Leave this page and lose them?";

export function SwarmSection({
  application,
  save,
}: {
  application: ApplicationDetail;
  save: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const canSave = usePermission({ service: ["update"] });
  const locked = application.aiModel ? AI_MODEL_LOCKED_CONCERNS : [];
  const gate: Gate = {
    allowed: canSave.allowed,
    refusal: roleRefusal("change this Application’s Swarm settings"),
  };
  // The keys its kind takes of the seven are config-owned on a Service a
  // repository-kept file describes.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  const owned =
    lock !== null ? configOwnedConcerns(application.configKind) : [];
  const ownedGate: Gate | null = lock
    ? {
        allowed: false,
        refusal: canSave.allowed ? lockRefusal(lock) : gate.refusal,
      }
    : null;
  const form = useApiForm<SwarmValues>({
    schema,
    defaultValues: toSwarmValues(application) as never,
    onSubmit: async (values) => {
      // Enter in a field submits whatever the button says.
      if (!gate.allowed) {
        form.setError("root", { type: "manual", message: gate.refusal });
        return;
      }
      await save(
        withoutLocked(toSwarmColumns(values, application), [
          ...locked,
          ...owned,
        ]),
      );
      // What was saved is the new baseline, so the form is no longer dirty
      // and leaving asks nothing.
      form.reset(values);
      toast.done("Swarm settings saved.", {
        description: "They reach the service on the next Deployment.",
      });
    },
    onError: (error) => toast.error(error),
    locate: (path) => CONCERN_OF_COLUMN[path],
  });

  const values = form.watch() as SwarmValues;
  // Eleven cards share the Save at the bottom, so an edit to the first is the
  // easiest one on the console to walk away from.
  const dirty = form.formState.isDirty;
  useUnsavedChangesGuard(dirty, SWARM_UNSAVED);
  const concerns = swarmConcerns(values, toSwarmValues(application)).filter(
    (concern) => !locked.includes(concern.id),
  );

  return (
    <section className="grid gap-3">
      <SectionHeading
        title="Docker Swarm"
        lede="Overrides passed straight through to the Docker Engine API when this Application is deployed. Everything here is optional; a concern left empty is not sent at all."
      />

      {lock && owned.length > 0 ? (
        <ConfigLockNote
          lock={lock}
          what={`${ownedConcernWords(owned)} ${owned.length === 1 ? "is" : "are"} this Service’s native.docker,`}
          rest="Placement, networks, ports and the mode stay editable here."
        />
      ) : null}

      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit} className="grid gap-3">
          {concerns.map((concern) => (
            <Card key={concern.id}>
              <Card.Header
                title={concern.title}
                sub={concern.lede}
                headingLevel={3}
              />
              <Card.Body className="grid gap-3.5">
                {/* Above the fields it is about, rather than under the Save
                    button with the other ten cards' refusals. */}
                <FormError message={form.groupErrors[concern.id]} />
                {concern.fields.map((field) => (
                  <ResourceField
                    key={field.name}
                    spec={field}
                    values={values}
                    gate={
                      ownedGate && owned.includes(concern.id) ? ownedGate : gate
                    }
                  />
                ))}
              </Card.Body>
              {concern.note ? <Card.Footer>{concern.note}</Card.Footer> : null}
            </Card>
          ))}

          <FormError message={form.rootError} />

          {/*
            One Save for all eleven, at the end rather than in each card. A
            sticky bar was the alternative and it is wrong here: this section
            sits inside a page that already scrolls, and a second fixed control
            over a long form is how someone ends up unable to reach the footer
            on a phone.
          */}
          <div className="flex flex-wrap items-center gap-2.5">
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={!gate.allowed}
              title={gate.allowed ? undefined : gate.refusal}
            >
              Save Swarm settings
            </SubmitButton>
            <p className="text-meta text-tx-2">
              {!gate.allowed ? (
                gate.refusal
              ) : dirty ? (
                <strong className="font-medium text-warn">
                  Unsaved changes — nothing here is kept until you save.
                </strong>
              ) : (
                "All eleven are sent together, so the spec is never half-applied."
              )}
            </p>
          </div>
        </form>
      </FormProvider>
    </section>
  );
}

/** The columns of `locked` concerns taken out of a save. */
function withoutLocked(
  columns: Record<string, unknown>,
  locked: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(columns).filter(
      ([column]) => !locked.includes(CONCERN_OF_COLUMN[column] ?? ""),
    ),
  );
}
