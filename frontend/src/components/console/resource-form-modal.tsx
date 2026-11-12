import { useId, useState } from "react";
import { FormProvider, type FieldValues } from "react-hook-form";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import {
  TestResult,
  testDetails,
  type TestOutcome,
} from "@/components/console/test-result";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";

import { ResourceField } from "@/components/console/resource-field";
import type {
  ResourceSpec,
  TestCredentials,
  TestSecret,
} from "./resource-spec";

/**
 * Add one, or edit one. **One dialog for both**, because `POST /` and
 * `PATCH /:id` take the same body on every one of these controllers — the only
 * differences are which call is made and what the title says. Two dialogs would
 * be two sets of fields to keep in step, and F08 already found that the version
 * that drifts is always the edit one.
 *
 * The caller keys this on the row (and on a counter for the add case), so every
 * opening mounts fresh: `useApiForm` reads `defaultValues` exactly once, and a
 * dialog that survives a close otherwise offers to save what was typed into the
 * previous one. That is not optional per list — see `resource-spec.ts`.
 *
 * **`spec.test` puts the connection test in here** (F15) rather than on the row,
 * because a test *before* the row exists can only happen in a form. Once an
 * id-taking route was added beside each credential-taking one, the second case
 * — test the thing as it is saved — became the same button rather than a new
 * one: this dialog reads which credential boxes are filled in and the spec says
 * what that means. The result stays *in the dialog*: this is the box the person
 * is looking at, and a corner toast about it is one they have to go and find —
 * the same argument `delete-resource-modal.tsx` makes about its refusal.
 */
export function ResourceFormModal<Row, Values extends FieldValues>({
  spec,
  row,
  open,
  onOpenChange,
}: {
  spec: ResourceSpec<Row, Values>;
  /** The row being edited, or `null` to add one. */
  row: Row | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const editing = row !== null;

  // A credential the service cannot work without is refused on an *add* with
  // the other empty fields, not by the backend one submit later. On an
  // edit an empty box means "keep the stored one", so it is never refused.
  const required = editing
    ? []
    : (spec.secrets ?? spec.test?.secrets ?? []).filter(
        (secret) => secret.required,
      );
  const schema =
    required.length === 0
      ? spec.schema
      : spec.schema.superRefine((typed, ctx) => {
          const on = shown();
          for (const secret of required) {
            const value: unknown = (typed as Record<string, unknown>)[
              secret.name
            ];
            if (!on.has(secret.name)) continue;
            if (typeof value === "string" && value.trim() !== "") continue;
            ctx.addIssue({
              code: "custom",
              path: [secret.name],
              message: `Enter ${secret.label}.`,
            });
          }
        });

  const form = useApiForm<Values>({
    schema: schema as typeof spec.schema,
    labelOf: (name) => {
      const label = spec.fields.find((field) => field.name === name)?.label;
      return typeof label === "string" ? label : undefined;
    },
    defaultValues: spec.toDefaults(row) as never,
    onSubmit: async (values) => {
      if (editing) {
        await spec.update(row, values);
        toast.done(`${sentenceCase(spec.noun)} saved.`);
      } else {
        await spec.create(values);
        toast.done(`${sentenceCase(spec.noun)} added.`);
      }
      onOpenChange(false);
    },
    onError: (error) => toast.error(error),
    // A field this dialog is not rendering cannot show a refusal.
    // Every kind of mount carries `volumeName` in its values, but only a volume
    // mount has the input, so a 400 naming it on a file mount marked a box that
    // is not on screen: no toast, no message, and the dialog just sat there.
    // Those are read out above the buttons instead, where the person is.
    locate: (path) => (shown().has(path) ? undefined : null),
  });

  // Read once per render and handed down, rather than each field subscribing:
  // a field that is only shown for one value of another (`hostPath` on a bind
  // mount) has to re-render when *that* value changes, and `watch()` with no
  // argument is the subscription that covers every such pair at once.
  const values = form.watch() as Values;

  /**
   * Which fields have an input on screen right now — the same `when` the body
   * below renders by, asked again when a refusal comes back. A function rather
   * than a value because `locate` is handed over before `values` exists, and
   * what it needs is the values as they are at submit time.
   */
  function shown(): Set<string> {
    return new Set(
      spec.fields
        .filter((field) => !field.when || field.when(form.getValues()))
        .map((field) => field.name),
    );
  }

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestOutcome | null>(null);
  // Which credential boxes are filled in is a fact about this form, so the
  // dialog works it out once; what an empty one *means* is per resource and stays
  // with the spec.
  const credentials = testCredentials(spec.test?.secrets, values);
  const blocked = spec.test?.blocked?.(values, credentials) ?? null;
  const blockedId = useId();

  async function runTest() {
    // Base UI already swallows a click on a `disabled` button; this is the same
    // refusal said once more where the request is made, so a future caller that
    // reaches `runTest` some other way cannot send what `blocked` ruled out.
    if (!spec.test || blocked !== null || testing) return;
    setResult(null);
    setTesting(true);
    try {
      setResult({ ok: true, message: await spec.test.run(values, credentials) });
    } catch (error) {
      const message = errorMessage(error);
      const details = testDetails(error);
      setResult({
        ok: false,
        message: spec.test.redact?.(message, values) ?? message,
        details:
          details === undefined
            ? undefined
            : (spec.test.redact?.(details, values) ?? details),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={editing ? `Edit ${spec.rowName(row)}` : spec.addLabel}
        description={spec.lede}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            {spec.fields.map((field) => (
              <ResourceField key={field.name} spec={field} values={values} />
            ))}
            <FormError message={form.rootError} />
            {/* Why the test is off, **inside the body**.
                It was after `Modal.Footer` first, which put it 209px below the
                dialog's own bottom edge — measured, not guessed. The footer is
                sticky and the body is the scroll region, so anything after the
                footer is outside the box entirely. A control that is off and
                cannot say why is the exact thing F03's `aria-disabled` rule
                exists to prevent, and it was silently reintroduced here. */}
            {blocked && spec.test ? (
              <p
                id={blockedId}
                className="rounded-md border border-line bg-panel-2 px-3 py-2.5 text-meta wrap-anywhere text-tx-2"
              >
                {blocked}
              </p>
            ) : null}
            {result ? <TestResult result={result} /> : null}
          </Modal.Body>
          <Modal.Footer>
            {spec.test ? (
              // `disabled`, not a hand-written `aria-disabled`. Our
              // `Button` turns `disabled` into `aria-disabled` itself — still
              // focusable, still the inert look — *and* swallows the click. The
              // hand-written attribute got the look and the announcement and
              // left the click live, so a test that could not run was sent
              // anyway and answered with the DTO's "expected string".
              <Button
                type="button"
                onClick={runTest}
                disabled={blocked !== null || testing}
                aria-busy={testing || undefined}
                aria-describedby={blocked ? blockedId : undefined}
                title={blocked ?? undefined}
              >
                {spec.test.label}
              </Button>
            ) : null}
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {editing ? "Save changes" : spec.addLabel}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}

/**
 * Which of the declared credentials still have an empty box.
 *
 * Whitespace is empty: every one of these specs trims before it sends, so a
 * space is not a credential and a button that came on for one would be lying.
 */
function testCredentials<Values extends FieldValues>(
  secrets: TestSecret[] | undefined,
  values: Values,
): TestCredentials {
  const blank = (secrets ?? []).filter((secret) => {
    const typed: unknown = values[secret.name];
    return typeof typed !== "string" || typed.trim() === "";
  });
  return { blank, needed: blank.filter((secret) => secret.required) };
}

/** "mount" → "Mount". The nouns are stored lower case because most uses are mid-sentence. */
function sentenceCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
