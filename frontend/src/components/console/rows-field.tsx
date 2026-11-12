import { useFieldArray, useFormContext } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import type { RowColumn } from "@/components/console/form-spec";
import type { Gate } from "@/lib/auth/use-permission";

/**
 * A repeating group of small fields — the one control behind every array-shaped
 * thing on the Advanced tab.
 *
 * Networks, published ports, ulimits, placement preferences, placement platforms
 * and Docker labels are all "a short list of little records", so they share
 * this one control rather than a form each.
 *
 * Two details that are easy to get wrong and are decided here rather than per
 * caller:
 *
 * 1. **The row's fields are labelled, not placeheld.** A grid of bare inputs
 *    with grey hints inside them is unreadable the moment someone types, and
 *    unusable with a screen reader from the start. The labels are `sr-only` past
 *    the first row — the column heading is on screen once, and the accessible
 *    name is on every input.
 * 2. **Removing names the row.** "Remove" alone in a stack of identical buttons
 *    is six identical accessible names; each says which row it removes.
 *
 * `useFieldArray` owns the ids, so a row removed from the middle does not
 * re-key the ones after it and take their focus with it.
 *
 * **`gate` turns the adder off, with the reason**, for a caller whose
 * role the form's own save would refuse — the form's owner reads the verdict
 * and hands it down, as `SettingsCard` takes its `gate`. The rows already there
 * stay editable, like every other field on a form its reader cannot save.
 */
export function RowsField({
  name,
  label,
  hint,
  columns,
  addLabel,
  emptyLabel,
  gate,
}: {
  name: string;
  label: string;
  hint?: React.ReactNode;
  columns: readonly RowColumn[];
  addLabel: string;
  emptyLabel: string;
  /** Whether this caller may add a row, and why not — see the note above. */
  gate?: Gate;
}) {
  const allowed = gate?.allowed ?? true;
  const form = useFormContext();
  const array = useFieldArray({ control: form.control, name });

  const blank = Object.fromEntries(columns.map((column) => [column.name, ""]));

  return (
    <fieldset className="grid gap-2">
      <legend className="text-body font-medium text-tx">{label}</legend>
      {hint ? <p className="text-meta text-tx-2">{hint}</p> : null}

      {array.fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-meta text-tx-3">
          {emptyLabel}
        </p>
      ) : null}

      {array.fields.map((row, index) => (
        <div
          key={row.id}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel-2 p-2.5"
        >
          {columns.map((column) => (
            <div
              key={column.name}
              className={cn(
                "grid min-w-0 gap-1",
                column.narrow ? "basis-24 grow-0" : "flex-1 basis-40",
              )}
            >
              <Label
                htmlFor={`${name}-${index}-${column.name}`}
                className={cn(
                  "text-meta text-tx-2",
                  index > 0 && "sr-only",
                )}
              >
                {column.label}
              </Label>
              {column.kind === "lines" ? (
                <Textarea
                  id={`${name}-${index}-${column.name}`}
                  rows={2}
                  placeholder={column.placeholder}
                  className="max-h-24 font-mono text-meta"
                  {...form.register(`${name}.${index}.${column.name}`)}
                />
              ) : (
                <Input
                  id={`${name}-${index}-${column.name}`}
                  type={column.kind === "number" ? "number" : "text"}
                  inputMode={column.kind === "number" ? "numeric" : undefined}
                  placeholder={column.placeholder}
                  className={cn(
                    "font-mono text-meta",
                    column.kind === "number" && "num",
                  )}
                  {...form.register(`${name}.${index}.${column.name}`)}
                />
              )}
            </div>
          ))}
          <Button
            type="button"
            size="icon-sm"
            variant="qt"
            onClick={() => array.remove(index)}
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
          >
            <Icon name="trash" size={15} />
          </Button>
        </div>
      ))}

      <div>
        <Button
          type="button"
          size="sm"
          disabled={!allowed}
          title={allowed ? undefined : gate?.refusal}
          onClick={() => allowed && array.append(blank)}
        >
          <Icon name="plus" size={14} />
          {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}
