import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import type { ZodType } from "zod";

import { isApiError } from "@/lib/api/api-error";
import { errorMessage, fieldSentence } from "@/lib/api/error-message";

/**
 * The console's one form library: **react-hook-form with a zod resolver.**
 *
 * zod because the backend is already zod-first — every DTO is a
 * `createZodDto` wrapper — so a form schema is the same shape of thing the
 * endpoint will check, written in the same language. react-hook-form because
 * it keeps the inputs uncontrolled, which matters on the wider screens here
 * (a Server form has forty fields, and re-rendering all of them per keystroke
 * is visible).
 *
 * The part worth having is the failure path. The backend refuses in two
 * different ways and they want two different answers:
 *
 * - **400 with field issues** — the person can fix it. Each issue goes back to
 *   its own field, where the mistake is.
 * - **anything else** — 403, 409, 500, the backend not running. There is no
 *   field to blame, so it goes to the form's root error and, if the caller
 *   wants, to a toast.
 *
 * "Its own field" is not always where the person can see it, which is what
 * {@link UseApiFormOptions.locate} is for: a field the form is not
 * currently rendering, or a backend name that is a whole card rather than an
 * input, would otherwise be marked somewhere nobody is looking.
 */
export type UseApiFormOptions<Values extends FieldValues> = {
  schema: ZodType<Values>;
  defaultValues: DefaultValues<Values>;
  /** Throw from here and the refusal is routed for you. */
  onSubmit: (values: Values) => Promise<void> | void;
  /** Called with anything that was not a field-level refusal. Toast it. */
  onError?: (error: unknown, message: string) => void;
  /**
   * Where a refused value is shown, when the field the backend names is not
   * where the person would see it. Called with the first segment of the issue's
   * path, and answers with one of three things:
   *
   * - `undefined` — leave the default: the field it names if this form has one,
   *   and the root error if it does not.
   * - `null` — the root error, whatever the form knows about the name. A
   *   dialog that hides a field for the kind of row being edited says this, so
   *   that a refusal on a hidden input is read out rather than set on a box
   *   that is not on screen.
   * - a **group key** — a slot the form renders its own `FormError` into, read
   *   back off {@link ApiForm.groupErrors}. What a form made of cards says, so
   *   a refusal naming a stored column lands on the card that edits it.
   */
  locate?: (path: string) => string | null | undefined;
  /**
   * The field a **409** is about, when the form has one. A duplicate name is a
   * 409 with no field issues attached, but it is unambiguously about the name
   * just typed, so its message is set on this field instead of the root
   * error, and `onError` does not hear of it — the sentence is already beside
   * the input it is about, and a toast would say it twice.
   */
  conflictField?: Path<Values>;
  /**
   * The label a field is shown under, by its name. A backend refusal
   * that opens with the field's identifier — `secretAccessKey cannot be
   * empty` — is reworded to open with this instead, and zod's default for a
   * missing value becomes "<label> is needed.".
   */
  labelOf?: (name: string) => string | undefined;
  /** Everything else react-hook-form takes. */
  form?: Omit<UseFormProps<Values>, "resolver" | "defaultValues">;
};

export type ApiForm<Values extends FieldValues> = UseFormReturn<Values> & {
  /** Hand this to `<form onSubmit={…}>`. */
  submit: (event?: React.BaseSyntheticEvent) => Promise<void>;
  /** The refusal that had no field to land on, ready to render above the buttons. */
  rootError?: string;
  /**
   * The refusals `locate` sent to a group, keyed by the group it named and
   * joined into one sentence per group. Empty until a submit is refused, and
   * cleared by the next one.
   */
  groupErrors: Record<string, string>;
};

export function useApiForm<Values extends FieldValues>({
  schema,
  defaultValues,
  onSubmit,
  onError,
  locate,
  conflictField,
  labelOf,
  form: formOptions,
}: UseApiFormOptions<Values>): ApiForm<Values> {
  // Not react-hook-form's own error store: these are keyed by something that
  // is not a field, and `setError` on a name the form does not have leaves an
  // error `handleSubmit` will not clear on the next attempt.
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const form = useForm<Values>({
    // The cast is the one the resolver's own types need: a ZodType<Values> and
    // react-hook-form's Resolver<Values> agree on the value but not on the
    // context parameter, which we never use.
    resolver: zodResolver(schema as never, { error: missingNumber }) as never,
    defaultValues,
    ...formOptions,
  });

  const submit = form.handleSubmit(async (values) => {
    setGroupErrors({});
    try {
      await onSubmit(values);
    } catch (error) {
      const known = new Set(Object.keys(defaultValues ?? {}));

      if (isApiError(error) && error.isValidation) {
        // An issue whose path is not a field on this form would otherwise
        // vanish silently — the form would clear, nothing would be marked,
        // and the person would be left guessing. Those go to the root.
        const orphaned: string[] = [];
        const grouped: Record<string, string[]> = {};
        for (const issue of error.issues) {
          const field = issue.path.split(".")[0];
          const where = locate?.(field);
          if (typeof where === "string") {
            (grouped[where] ??= []).push(
              fieldSentence(issue.message, issue.path, labelOf?.(field)),
            );
          } else if (where === undefined && known.has(field)) {
            form.setError(issue.path as Path<Values>, {
              type: "server",
              // The backend's issues arrive as fragments; our own zod messages
              // are sentences. Beside the same input they have to be one voice.
              message: fieldSentence(
                issue.message,
                issue.path,
                labelOf?.(field),
              ),
            });
          } else {
            orphaned.push(`${issue.path}: ${issue.message}`);
          }
        }
        if (Object.keys(grouped).length > 0) {
          setGroupErrors(
            Object.fromEntries(
              Object.entries(grouped).map(([group, messages]) => [
                group,
                messages.join(" "),
              ]),
            ),
          );
        }
        if (orphaned.length > 0) {
          form.setError("root", {
            type: "server",
            message: `The backend refused a value this form does not show — ${orphaned.join("; ")}.`,
          });
        }
        return;
      }

      const message = errorMessage(error);
      if (conflictField && isApiError(error) && error.status === 409) {
        form.setError(conflictField, { type: "server", message });
        return;
      }
      form.setError("root", { type: "server", message });
      onError?.(error, message);
    }
  });

  return Object.assign(form, {
    submit,
    rootError: form.formState.errors.root?.message,
    groupErrors,
  });
}

/**
 * What a number box that was left empty says, when its schema did not say.
 *
 * A `kind: "number"` field hands its schema `undefined` for an
 * emptied box rather than `""`. Before, `z.coerce.number()` read `""` as **0**
 * — so clearing Replicas and saving stopped the Application, and nothing said
 * so. Now it is refused, and zod's own words for that are "Invalid input:
 * expected number, received NaN", the same raw sentence the empty box used to show.
 * A parse-level map is the lowest precedence zod has, so every message a
 * schema writes for itself still wins; this only fills the gap. Rejected:
 * giving each of the dozen coerced schemas its own `error`, which is the per-
 * site fix that leaves the next one to be written without it.
 */
function missingNumber(issue: {
  code: string;
  expected?: unknown;
  input?: unknown;
}): string | undefined {
  if (issue.code !== "invalid_type" || issue.expected !== "number") return;
  const input = issue.input;
  if (input === undefined || (typeof input === "number" && Number.isNaN(input))) {
    return "Enter a number.";
  }
  return undefined;
}
