import * as React from "react";
import {
  Controller,
  useFormContext,
  type FieldValues,
  type RegisterOptions,
} from "react-hook-form";

import {
  Field as UiField,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

export type FieldProps = {
  /** The path react-hook-form registers, and the path the backend's issues use. */
  name: string;
  label: React.ReactNode;
  /** What a good value looks like. Say it before they get it wrong. */
  hint?: React.ReactNode;
  /**
   * An error to show without a form around it. Inside a `FormProvider` the
   * form's own error for `name` wins, so a screen never has to keep two
   * copies of the same message in step.
   */
  error?: string;
  /** Say so, rather than starring the required ones and explaining the star. */
  optional?: boolean;
  /**
   * Do not register the child; its value is already wired by a `Controller`.
   *
   * `register` attaches to a DOM input, and a Select, a Switch or a radio-card
   * grid is a **button** — there is nothing for it to attach to, so
   * react-hook-form's own answer is `Controller` (see **Forms** in
   * `frontend/docs/design-system.md`). Registering such a field anyway hands the
   * child an `onChange` expecting a DOM event and claims the same name the
   * Controller is managing, which is one source of truth too many.
   *
   * Everything else Field does still applies: it owns the label, the hint, the
   * `id`, the aria wiring, and it reads the **form's** error for `name` — a
   * Controller reports under the same name, so the message still lands here.
   */
  manual?: boolean;
  /**
   * What `register` is told besides the name — a number box's conversion.
   * Ignored when `manual`, since nothing is registered then.
   */
  registerOptions?: RegisterOptions;
  orientation?: "vertical" | "horizontal";
  className?: string;
  /** Exactly one control. It is given its id, its registration and its aria wiring. */
  children: React.ReactElement<Record<string, unknown>>;
};

function messageAt(errors: FieldValues, path: string): string | undefined {
  const found = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      errors,
    );
  const message = (found as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : undefined;
}

/**
 * A labelled control, its hint, and its error — wired together.
 *
 * This is the only place the console does form plumbing. It hands the child
 * its `id`, registers it with the form if there is one, sets `aria-invalid`,
 * and points `aria-describedby` at whichever of the hint and the error are on
 * screen. A feature phase writes the label and the hint and nothing else.
 *
 * The error it renders is the same string `useApiForm` puts there, which is
 * the backend's own message for that field — so "Name cannot be empty."
 * appears under Name, not in a toast in the corner.
 */
export function Field({
  name,
  label,
  hint,
  error,
  optional,
  manual,
  registerOptions,
  orientation = "vertical",
  className,
  children,
}: FieldProps) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Optional on purpose: the gallery, and any one-off filter, use Field
  // without a form around it. `useFormContext` returns null there.
  const form = useFormContext();
  const registered = form && !manual ? form.register(name, registerOptions) : undefined;
  const message = form
    ? messageAt(form.formState.errors, name)
    : error;

  const describedBy =
    [hint ? hintId : null, message ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const labelNode = (
    // `wrap-anywhere`: a label can quote a value — ConfirmDeleteModal's "Type
    // <name> to confirm" — and a long name must wrap, not push the dialog's
    // buttons out of view.
    <FieldLabel
      htmlFor={id}
      className="min-w-0 text-body font-medium wrap-anywhere text-tx"
    >
      {label}
      {optional ? (
        <span className="text-meta font-normal text-tx-3">optional</span>
      ) : null}
    </FieldLabel>
  );

  const hintNode = hint ? (
    <FieldDescription id={hintId} className="text-meta text-tx-2">
      {hint}
    </FieldDescription>
  ) : null;

  const errorNode = message ? (
    <FieldError id={errorId} className="text-meta text-bad">
      {message}
    </FieldError>
  ) : null;

  const wiring = {
    id,
    "aria-invalid": message ? true : undefined,
    "aria-describedby": describedBy,
  };
  const control = wire(children, { ...wiring, ...registered });

  return (
    <UiField
      orientation={orientation}
      data-invalid={message ? true : undefined}
      /**
       * `min-w-0` is load-bearing, and F13 paid for it (measured in the browser).
       *
       * `Textarea` carries base-nova's `field-sizing-content`, which is right for
       * its *height* — a control holding a dotenv blob should grow — and makes its
       * preferred **width** content-based too. In a flex or grid parent that
       * becomes a max-content contribution, so a textarea holding one unbreakable
       * token pushes its whole container wider: an SSH public key made a 600px
       * dialog 661px wide and gave it a horizontal scrollbar, clipping its own
       * footer buttons. `min-width: 0` on the textarea does not fix it — the
       * contribution comes through the ancestors — and `max-w-full` does not
       * either, because the *track* is already too wide by then.
       *
       * The same trap the design system documents twice over: `shell-grid`'s
       * `minmax(0,1fr)`, and the `min-w-0 flex-1` beside every truncating cell.
       * It belongs here rather than at each call site, because every dialog in the
       * console that holds a textarea inherits it — a long `DATABASE_URL` pasted
       * into a variables editor is the same shape of value.
       */
      className={cn("min-w-0 gap-1.5", className)}
    >
      {/*
        Side by side, the words stack in their own column and the control sits
        at the end of the row. Laying label, control and hint out as three
        items in one flex row is what puts a switch between a label and the
        sentence explaining it.
      */}
      {orientation === "horizontal" ? (
        <>
          <FieldContent>
            {labelNode}
            {hintNode}
            {errorNode}
          </FieldContent>
          {control}
        </>
      ) : (
        <>
          {labelNode}
          {control}
          {hintNode}
          {errorNode}
        </>
      )}
    </UiField>
  );
}

/**
 * Hand `child` the wiring — or, when it is a react-hook-form `Controller`, hand
 * it to whatever the Controller renders.
 *
 * A Switch, a Picker or a Segmented inside a form is a `manual` Field whose
 * child is a `Controller`, and cloning the Controller put `id`,
 * `aria-describedby` and `aria-invalid` on a component that drops them: the
 * label's `htmlFor` pointed at nothing, every spec-built switch had no
 * accessible name, and no hint or error was linked. So the Controller's
 * `render` is wrapped and its output is cloned instead, which fixes every
 * Controller-in-a-Field at once rather than asking each `render` to remember.
 */
function wire(
  child: React.ReactElement<Record<string, unknown>>,
  props: Record<string, unknown>,
): React.ReactElement {
  if (child.type !== Controller) return React.cloneElement(child, props);
  const render = child.props.render as (
    ...args: unknown[]
  ) => React.ReactElement<Record<string, unknown>>;
  return React.cloneElement(child, {
    render: (...args: unknown[]) => React.cloneElement(render(...args), props),
  });
}

/**
 * The refusal that had no field to land on — a 403, a 409, a backend that is
 * not answering. It goes above the buttons, where someone is already looking
 * when they press one.
 */
export function FormError({
  message,
  className,
}: {
  message?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={cn(
        // `animate-fade`: a refusal appears in place, after the press that caused it.
        "flex animate-fade items-start gap-2 rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-body wrap-anywhere text-bad",
        className,
      )}
    >
      <Icon name="alert" className="mt-0.5 flex-none" />
      {message}
    </p>
  );
}
