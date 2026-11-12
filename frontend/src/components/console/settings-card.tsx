import { FormProvider, type FieldValues, type Path } from "react-hook-form";
import type { ZodType } from "zod";

import { Card } from "@/components/console/card";
import { FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import type { Gate } from "@/lib/auth/use-permission";

import { ResourceField } from "@/components/console/resource-field";
import type { FieldSpec } from "@/components/console/form-spec";

/**
 * A card that is a form over a few columns of the Application row.
 *
 * The other half of F10's reuse story. `ResourceList` covers "a table of child
 * records"; this covers "a handful of fields that `PATCH /applications/:id`",
 * which is what Resources, the run command, the build server, the preview
 * settings and every one of the eleven Swarm concerns are. Both render their
 * fields through the same `ResourceField`, so a Select in a dialog and a Select
 * in a card are the same control wired the same way.
 *
 * **These cards are always editable** — no read-out state with an Edit button,
 * which is what F08's variables card and F09's source card have. That is a
 * deliberate split rather than an inconsistency: those two guard a *destructive
 * shape of edit* (a whole dotenv blob replaced at once, a source type switched
 * out from under a build) and the read state is what stops a stray keystroke
 * doing it. Four numeric limits and a run command are neither destructive nor
 * long, and putting them behind a button costs a click on every visit to save
 * nothing.
 *
 * What every one of them does carry is the sentence about **when the change
 * lands**: none of this reaches the running container until the next Deployment,
 * and a card that saves instantly without saying so implies otherwise.
 *
 * **`gate` turns Save off, with the reason, for a caller the route will refuse**
 * The fields stay
 * live, as they do on the Project's details form: someone who cannot save can
 * still read what is set and see why it is not theirs to change. Optional,
 * because some of these write the caller's own account and no role enters into
 * it; `lib/auth/gated-controls.test.ts` finds every usage and fails on one
 * that passes no `gate` and is not named, with its reason or its route, there.
 */
export function SettingsCard<Values extends FieldValues>({
  title,
  lede,
  fields,
  schema,
  defaultValues,
  submit,
  savedMessage,
  headingLevel = 2,
  footer,
  children,
  actions,
  gate,
  clearAfterSave,
}: {
  title: React.ReactNode;
  lede?: React.ReactNode;
  /**
   * A function when a field's own words depend on what has been typed.
   *
   * The Resources card is why: its memory fields take `1536` as megabytes,
   * and a hint that says "= 1.5 GB" as it is typed is what keeps a bare
   * number's unit from being a guess.
   */
  fields: FieldSpec<Values>[] | ((values: Values) => FieldSpec<Values>[]);
  schema: ZodType<Values>;
  defaultValues: Values;
  submit: (values: Values) => Promise<unknown>;
  /**
   * What the toast says. Name what changed, not that something changed. A
   * function reads it off what `submit` resolved to, for a save whose answer
   * decides the sentence.
   */
  savedMessage: string | ((saved: unknown) => string);
  headingLevel?: 2 | 3;
  /** The `--panel-2` strip under the fields — usually when the change lands. */
  footer?: React.ReactNode;
  /** Anything above the fields: an explanation, a warning, a read-out. */
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /** Whether this caller may save, and why not — see the note above. */
  gate?: Gate;
  /**
   * Fields emptied once a save lands: write-only secrets, whose empty field
   * means "keep what is stored". Left holding what was typed, a saved
   * password read as one still waiting to be saved.
   */
  clearAfterSave?: readonly Path<Values>[];
}) {
  const allowed = gate?.allowed ?? true;
  const form = useApiForm<Values>({
    schema,
    defaultValues: defaultValues as never,
    onSubmit: async (values) => {
      // Enter in a field submits whatever the button says.
      if (!allowed) {
        form.setError("root", { type: "manual", message: gate?.refusal });
        return;
      }
      const saved = await submit(values);
      if (clearAfterSave?.length) {
        const cleared = { ...values } as Record<string, unknown>;
        for (const name of clearAfterSave) cleared[name] = "";
        form.reset(cleared as Values);
      }
      toast.done(
        typeof savedMessage === "function" ? savedMessage(saved) : savedMessage,
      );
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch() as Values;
  const specs = typeof fields === "function" ? fields(values) : fields;

  return (
    <Card>
      <Card.Header
        title={title}
        sub={lede}
        headingLevel={headingLevel}
        actions={actions}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Card.Body className="grid gap-3.5">
            {children}
            {specs.map((field) => (
              <ResourceField
                key={field.name}
                spec={field}
                values={values}
                gate={gate}
              />
            ))}
            <FormError message={form.rootError} />
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <SubmitButton
                pending={form.formState.isSubmitting}
                disabled={!allowed}
                title={allowed ? undefined : gate?.refusal}
              >
                Save changes
              </SubmitButton>
            </div>
          </Card.Body>
          {footer ? <Card.Footer>{footer}</Card.Footer> : null}
        </form>
      </FormProvider>
    </Card>
  );
}
