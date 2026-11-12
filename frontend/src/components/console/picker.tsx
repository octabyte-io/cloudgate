import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The value an option whose own value is `""` carries **inside** Base UI.
 *
 * Base UI has one representation of "nothing chosen" and it is `null`; it also
 * treats a value that serializes to `""` as empty (`SelectRoot`'s
 * `hasSelectedValue`). So a `Picker` whose "none" option is spelled `""` — the
 * console has several, "This Cloudgate host" and "No team" among them — hands
 * the root `null`, offers an item worth `""`, and then selecting that item
 * commits a value the root already considers empty. Nothing changes, the item is
 * never `selected`, `selectedIndex` stays `null`, and the popup is left painted
 * over a select that reports `aria-expanded="false"`.
 *
 * The fix is the one the issue asks for: give that option a value of its own, so
 * choosing it is a change like any other. It exists only between this component
 * and Base UI — callers still pass and receive `""` — and it is deliberately
 * unspellable as a server id, a branch or a key, which is the whole job.
 */
const NONE = "__cloudgate_picker_none__";

export type PickerOption = {
  value: string;
  label: string;
  /**
   * A quieter note **beside** the label — a commit, a host, a namespace.
   *
   * Beside and not under, and that is not a preference: a select row is `h-8`,
   * and a stacked pair is taller than that, so the popup clipped the label of the
   * first option and the list read as a column of orphaned shas. Found by looking
   * at it. One line per option is what the geometry supports.
   */
  detail?: string;
  /**
   * Shown but not choosable, its `detail` saying why: a Bought Server that is
   * still Setting up. Left in the list rather than out of it, because the
   * Server is the operator's and they will look for it there.
   */
  disabled?: boolean;
};

export type PickerProps = {
  options: readonly PickerOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** What the trigger says with nothing chosen. Never a label in disguise. */
  placeholder?: string;
  disabled?: boolean;
  /** Set while the options are still arriving, so the trigger says so. */
  pending?: boolean;
  /** Set in mono — a branch, a repository, an image reference. */
  mono?: boolean;
  id?: string;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

/**
 * One choice from a short list — the six shadcn Select primitives, composed.
 *
 * It exists because a select is five components at every call site and this
 * phase alone has eight of them: a git connection, a repository's branch, a
 * builder's registry, an SSH key, a certificate resolver. Assembling
 * `Select` / `Trigger` / `Value` / `Content` / `Item` by hand eight times is how
 * one of them ends up a different height from the input above it.
 *
 * **It is a button, not an input**, so inside a form it wants react-hook-form's
 * `Controller` and its `Field` wants `manual` — see **Forms** in
 * `frontend/docs/design-system.md`. Base UI brings the keyboard: arrows, Home/End,
 * typeahead, Escape.
 *
 * Past ~20 options a list you cannot filter is the wrong control. For the one
 * genuinely long list in the console — a git connection's repositories — see
 * `features/application/source/repository-picker.tsx`, which is a filterable list
 * rather than a popup for exactly that reason.
 */
export function Picker({
  options,
  value,
  onValueChange,
  placeholder = "Choose one",
  disabled,
  pending,
  mono,
  id,
  className,
  ...aria
}: PickerProps) {
  const chosen = options.find((option) => option.value === value);

  // `""` means "this list offers it as a choice" when an option carries it and
  // "nothing chosen" when none does, and only the first case wants `NONE`:
  // handing the root a value that matches no item would otherwise make an empty
  // picker read as filled, which is what drives the trigger's placeholder and a
  // `Field`'s filled state.
  const emptyIsAnOption = options.some((option) => option.value === "");
  const toSelect = (external: string) =>
    external === "" ? (emptyIsAnOption ? NONE : null) : external;

  return (
    <Select
      value={toSelect(value)}
      onValueChange={(next) =>
        onValueChange(next === null || next === NONE ? "" : String(next))
      }
      disabled={disabled || pending}
    >
      <SelectTrigger
        id={id}
        className={cn(mono && "font-mono text-meta", className)}
        {...aria}
      >
        <SelectValue>
          {pending ? (
            <span className="text-tx-3">Loading…</span>
          ) : chosen ? (
            chosen.label
          ) : (
            <span className="text-tx-3">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      {/* **`alignItemWithTrigger={false}`, and it is not a style choice.** Base
          UI's default select positioning overlaps the trigger to line the chosen
          item's text up with it, and to hold that alignment it pins the
          positioner with `position: fixed` and *turns anchor tracking off*
          (`SelectPositioner`: `disableAnchorTracking ?? alignItemWithTriggerActive`).
          Inside a scrolling dialog body that is a popup which neither follows its
          trigger nor closes when the trigger scrolls away — it just hangs at a
          viewport coordinate. It cost a real user a filled-in Add-a-database form:
          they scrolled, pressed Escape at what still looked like an open list, and
          it closed the modal instead. Anchored below the trigger, floating-ui's
          `autoUpdate` re-anchors on every ancestor scroll. */}
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === "" ? NONE : option.value}
            disabled={option.disabled}
          >
            <span
              className={cn("min-w-0 truncate", mono && "font-mono text-meta")}
            >
              {option.label}
            </span>
            {option.detail ? (
              <span className="flex-none font-mono text-meta font-normal text-tx-3">
                {option.detail}
              </span>
            ) : null}
          </SelectItem>
        ))}
        {options.length === 0 ? (
          <p className="flex items-center gap-2 px-2.25 py-2 text-meta text-tx-2">
            <Icon name="info" size={14} className="text-tx-3" />
            Nothing to choose from yet.
          </p>
        ) : null}
      </SelectContent>
    </Select>
  );
}
