import { Controller, useFormContext, type FieldValues } from "react-hook-form";

import { Field } from "@/components/console/field";
import type { FieldSpec } from "@/components/console/form-spec";
import { PasswordInput } from "@/components/console/password-input";
import { Picker } from "@/components/console/picker";
import { RowsField } from "@/components/console/rows-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Gate } from "@/lib/auth/use-permission";
import { cn } from "@/lib/utils";

/**
 * One `FieldSpec`, rendered.
 *
 * The whole reason a spec has a `kind` rather than a caller passing JSX is the
 * wiring difference underneath it, which is easy to get wrong and invisible when
 * you do: an `<input>` and a `<textarea>` are registered by `Field`, and a
 * `Picker` and a `Switch` are **buttons**, so they need a `Controller` and a
 * `Field` marked `manual` (see **Forms** in `frontend/docs/design-system.md`).
 * Registering a button hands it an `onChange` expecting a DOM event and claims a
 * name the Controller is already managing.
 *
 * Getting that decision out of every call site is worth more here than anywhere
 * else in the console, because F10 has roughly forty of these fields across four
 * lists and eleven Swarm concerns.
 */
export function ResourceField<Values extends FieldValues>({
  spec,
  values,
  gate,
}: {
  spec: FieldSpec<Values>;
  /** The form's current values, for a field that depends on another. */
  values: Values;
  /**
   * The form's save verdict, for the one kind that is a control as well as a
   * field: a `rows` adder is off, with the reason, when the save would be
   * refused.
   */
  gate?: Gate;
}) {
  const form = useFormContext();
  if (spec.when && !spec.when(values)) return null;

  // Beside the field rather than in its hint, which is the input's
  // accessible description — `FieldSpec.after` says why.
  if (spec.after) {
    return (
      <div className="grid min-w-0 gap-2.5">
        <ResourceField
          spec={{ ...spec, after: undefined }}
          values={values}
          gate={gate}
        />
        {spec.after}
      </div>
    );
  }

  // F15's addition, and the only kind that is not a control: a rule and a
  // heading between two groups of them. A notification's eight event switches
  // sitting straight under a webhook URL read as eight more settings *of* the
  // webhook, which is the opposite of what they are.
  if (spec.kind === "section") {
    return (
      <div className="border-t border-line pt-3.5 first:border-0 first:pt-0">
        <p className="text-body font-semibold text-tx">{spec.label}</p>
        {spec.hint ? (
          <p className="mt-1 text-meta text-tx-2">{spec.hint}</p>
        ) : null}
      </div>
    );
  }

  const common = {
    name: spec.name,
    label: spec.label,
    hint: spec.hint,
    optional: spec.optional,
  };
  const locked = lockedProps(spec.locked);

  if (spec.kind === "select") {
    return (
      <Field {...common} manual>
        <Controller
          name={spec.name}
          control={form.control}
          render={({ field }) => (
            <Picker
              options={spec.options}
              pending={spec.pending}
              disabled={spec.locked !== undefined}
              placeholder={spec.placeholder ?? "Choose one"}
              value={(field.value as string | null) ?? ""}
              onValueChange={field.onChange}
            />
          )}
        />
      </Field>
    );
  }

  if (spec.kind === "switch") {
    return (
      <Field {...common} manual orientation="horizontal">
        <Controller
          name={spec.name}
          control={form.control}
          render={({ field }) => (
            <Switch
              checked={Boolean(field.value)}
              disabled={spec.disabled || spec.locked !== undefined}
              title={spec.locked}
              onCheckedChange={field.onChange}
            />
          )}
        />
      </Field>
    );
  }

  if (spec.kind === "textarea") {
    return (
      <Field {...common}>
        <Textarea
          rows={spec.rows ?? 6}
          placeholder={spec.placeholder}
          {...locked}
          // A file's content and a shell script are read as code; `max-h`
          // rather than a row cap, because `field-sizing-content` is what makes
          // a short value take a short box.
          className={cn(
            "max-h-80 overflow-auto",
            spec.mono && "font-mono text-meta leading-log",
          )}
        />
      </Field>
    );
  }

  if (spec.kind === "lines") {
    return (
      <Field {...common}>
        <Textarea
          rows={spec.rows ?? 3}
          placeholder={spec.placeholder}
          {...locked}
          className="max-h-48 overflow-auto font-mono text-meta leading-log"
        />
      </Field>
    );
  }

  // Its own control rather than a `Field`, because a repeating group is a
  // `fieldset` with a `legend` and several labelled inputs — wrapping that in a
  // component whose whole job is to give *one* child an id and a label would
  // give the id to the first input and the label to none of them.
  if (spec.kind === "rows") {
    return (
      <RowsField
        name={spec.name}
        label={spec.label}
        hint={spec.hint}
        columns={spec.columns}
        addLabel={spec.addLabel}
        emptyLabel={spec.emptyLabel}
        gate={gate}
      />
    );
  }

  // F11's addition. A `text` field would put a live database password in plain
  // sight, and a bare `type="password"` would make a 16-character generated
  // string untypeable — `PasswordInput` is already the answer to both, and this
  // is the kind that reaches it from a spec.
  //
  // `new-password` unless the spec says otherwise. Every one of these
  // but the profile card's is a write-only secret — a webhook, an API key, a
  // header value — and Chrome ignores `off` on a password input: it filled the
  // console login's saved password into it, masked, and the email into the
  // text field before it, so an Uptime check's header carried the operator's
  // password to the probed host. `password-fields-autocomplete.test.tsx` holds
  // every spec field to this.
  if (spec.kind === "password") {
    return (
      <Field {...common}>
        <PasswordInput
          placeholder={spec.placeholder}
          {...locked}
          autoComplete={spec.autoComplete ?? "new-password"}
          spellCheck={false}
          className="font-mono text-meta md:text-meta"
        />
      </Field>
    );
  }

  // A number box holds a **number**. Registered bare, react-hook-form
  // held the input's string, so a spec saying `z.number()` refused every value
  // ("expected number, received string") and only the specs that happened to
  // say `z.coerce.number()` worked — the ports spec could never be saved.
  // `setValueAs` rather than `valueAsNumber`: the latter turns an emptied box
  // into `NaN`, which an optional field's schema then refuses as a number that
  // is not one; empty is `undefined`, the value that means "not given".
  // `resource-field.test.tsx` holds every number field in the tree to this.
  if (spec.kind === "number") {
    return (
      <Field {...common} registerOptions={{ setValueAs: toNumber }}>
        <Input
          type="number"
          inputMode="numeric"
          min={spec.min}
          max={spec.max}
          placeholder={spec.placeholder}
          {...locked}
          className="num"
        />
      </Field>
    );
  }

  return (
    <Field {...common}>
      <Input
        placeholder={spec.placeholder}
        {...locked}
        className={cn(spec.mono && "font-mono text-meta")}
      />
    </Field>
  );
}

/**
 * What a text control set elsewhere carries (`FieldSpec.locked`): read
 * only rather than disabled, because a disabled input drops out of the values
 * react-hook-form submits and a locked value has to ride along unchanged; the
 * reason is its hover title. Nothing when `reason` is absent.
 */
export function lockedProps(reason: string | undefined) {
  return reason
    ? { readOnly: true, title: reason, "aria-readonly": true as const }
    : {};
}

/**
 * A number box's value as the form holds it. The number the defaults put there
 * passes through, `""` is `undefined`, and anything else is `Number()` of it —
 * which for a `type="number"` input is only ever a number, because the browser
 * reports a value it cannot parse as `""`.
 */
function toNumber(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  return typeof value === "number" ? value : Number(value);
}
