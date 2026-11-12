import type { FieldValues } from "react-hook-form";

import type { PickerOption } from "@/components/console/picker";

/**
 * **One control in a form, as data.**
 *
 * Built by F10 inside `application/advanced/resource-spec.ts` and promoted here
 * by F11, which is the second phase to want the form half without the list half.
 * F10 needed it for "a table of child records"; a database's General, Credentials
 * and Advanced tabs are all *cards over a few columns of one row*, which is
 * `SettingsCard` and this type and nothing else.
 *
 * The reason a field has a `kind` rather than a caller passing JSX is the wiring
 * underneath, which is easy to get wrong and invisible when you do: an `<input>`
 * and a `<textarea>` are registered by `Field`, while a `Picker` and a `Switch`
 * are **buttons** and need a `Controller` and a `Field` marked `manual` (see
 * **Forms** in `frontend/docs/design-system.md`). `ResourceField` makes that
 * decision once for every form in the console.
 */

/** One control in a spec-driven form. */
export type FieldSpec<Values extends FieldValues> = {
  /** The form path, and the path a 400's field issue comes back on. */
  name: keyof Values & string;
  label: string;
  /** What a good value looks like. Said before they get it wrong. */
  hint?: React.ReactNode;
  /** Say so rather than starring the required ones and explaining the star. */
  optional?: boolean;
  /** An example, written with {@link example} unless it is a bare format. */
  placeholder?: string;
  /** Hidden when this returns false — a bind mount has no volume name. */
  when?: (values: Values) => boolean;
  /**
   * A block rendered **under** the field, outside it.
   *
   * For a control that helps fill the field in and is too big to be its
   * `hint`: the hint is the input's accessible description, so anything put
   * there is read out as part of the field. The AI provider's model lookup —
   * a button, a filter and up to two dozen model names — is the first. It
   * renders inside the form's `FormProvider`, so it can read and set values.
   */
  after?: React.ReactNode;
  /**
   * Set elsewhere, with the sentence that says where (a field a
   * repository-kept Project config owns). The control is read-only and says
   * so on hover; its value still rides along with the Save unchanged, which
   * the backend accepts as a restated value.
   */
  locked?: string;
} & (
  | { kind: "text"; mono?: boolean }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "textarea"; rows?: number; mono?: boolean }
  | { kind: "select"; options: readonly PickerOption[]; pending?: boolean }
  /**
   * A `Switch` — a button, so it takes a `Controller` and a `manual` Field.
   * `disabled` is the native attribute, for a switch another field's value
   * makes meaningless; its `hint` says why.
   */
  | { kind: "switch"; disabled?: boolean }
  /**
   * A secret, in a field you can read back.
   *
   * **Added by F11**, which is the first phase whose forms are mostly
   * credentials: five of the six database engines have a password on the create
   * form and on the Credentials tab, and one of them has two. A `text` field
   * would put a live database password in plain sight on a shared screen, and a
   * bare `type="password"` would make a 16-character generated string
   * untypeable. `PasswordInput` is the existing answer to exactly that.
   */
  | {
      kind: "password";
      /**
       * `new-password` when absent, which is what keeps Chrome from filling
       * the console login into a write-only secret. Only a field that
       * really is the sign-in password says `current-password`.
       */
      autoComplete?: string;
    }
  /**
   * A list of strings, one per line.
   *
   * A textarea rather than a repeating row, because these are always short
   * literals a person pastes in bulk — a Swarm constraint, a health-check
   * command, a network alias — and a stack of one-line inputs with a plus
   * button makes pasting four of them four operations.
   */
  | { kind: "lines"; rows?: number; placeholder?: string }
  /**
   * A repeating group. **The reason there are not five more form files.**
   *
   * Five of the eleven Swarm concerns are arrays of small objects — networks,
   * published ports, ulimits, placement preferences, placement platforms — and
   * so are Docker labels once a key and a value are two columns. This is one
   * `useFieldArray` form for all of them, as a field.
   */
  /**
   * Not a control — a rule and a heading between two groups of them.
   *
   * **Added by F15.** A notification's dialog is two things stacked: how to
   * reach the channel, and which events go to it. The second group is eight
   * switches, and eight unlabelled switches under a webhook URL read as eight
   * more settings of the webhook. `label` is the heading and `hint` the sentence
   * under it; `name` is only a React key, and no value is read or written.
   */
  | { kind: "section" }
  | {
      kind: "rows";
      columns: readonly RowColumn[];
      /** "Add a network". Says what a row *is*, not "Add row". */
      addLabel: string;
      /** One sentence where the table would be, when there are none. */
      emptyLabel: string;
    }
);

/** One column of a `rows` field. Values are strings; the spec converts them. */
export type RowColumn = {
  name: string;
  label: string;
  kind: "text" | "number" | "lines";
  placeholder?: string;
  /** Narrower than its neighbours — a port, a count. */
  narrow?: boolean;
};

/**
 * A placeholder that reads as an example, not a value: "e.g. nightly".
 *
 * A bare `nightly` in an empty Prefix box, `storefront` in Database name or
 * `Ops on-call` in a channel's Name looked typed in — and like a default that
 * would be used — right up until the submit said the field was empty.
 */
export function example(value: string): string {
  return `e.g. ${value}`;
}
