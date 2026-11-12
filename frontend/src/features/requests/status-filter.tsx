import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { RequestStatusClass } from "@/lib/api/endpoints/monitoring";
import { Icon } from "@/lib/design/icons";

/**
 * Narrow the request log to one or more status classes.
 *
 * A popover of checkboxes on F08's `TagFilter` argument, unchanged: a menu closes
 * when a row is chosen and picking both 4xx and 5xx is the ordinary case, and the
 * trigger carries the count so a filtered log never looks unfiltered.
 *
 * **Classes, not codes.** `isStatusInRange` maps five names onto the 1xx–5xx
 * bands — there is no way to ask for 404 on its own, which is the part
 * still open after the method filter was added and the search widened. So the
 * options here are exactly the five the backend understands, named the way an
 * operator says them, and each one carries its numeric band rather than only a
 * word: the whole point of the classes is the numbers.
 *
 * Several classes means **any** of them, which is what the backend does
 * (`status.some(...)`).
 */

/** The five, in the order they appear in a status code, with what each means. */
export const STATUS_CLASSES: {
  value: RequestStatusClass;
  label: string;
  band: string;
}[] = [
  { value: "info", label: "Informational", band: "1xx" },
  { value: "success", label: "Succeeded", band: "2xx" },
  { value: "redirect", label: "Redirected", band: "3xx" },
  { value: "client", label: "Client error", band: "4xx" },
  { value: "server", label: "Server error", band: "5xx" },
];

export function StatusFilter({
  selected,
  onChange,
}: {
  selected: ReadonlySet<RequestStatusClass>;
  onChange: (next: Set<RequestStatusClass>) => void;
}) {
  function toggle(value: RequestStatusClass, on: boolean) {
    const draft = new Set(selected);
    if (on) draft.add(value);
    else draft.delete(value);
    onChange(draft);
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Filter by status class, ${selected.size} selected`}
          >
            <Icon name="filter" size={15} />
            Status
            {selected.size > 0 ? (
              <span className="rounded-md bg-brand-tint px-1.25 text-chip text-brand-tx">
                {selected.size}
              </span>
            ) : null}
          </Button>
        }
      />
      <PopoverContent
        align="start"
        className="w-64 rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0"
      >
        <ul className="flex flex-col">
          {STATUS_CLASSES.map((option) => (
            <li key={option.value}>
              <label className="flex h-8 cursor-pointer items-center gap-2.25 rounded-md px-2.25 text-body text-tx hover:bg-raise">
                <Checkbox
                  checked={selected.has(option.value)}
                  onCheckedChange={(next) => toggle(option.value, next === true)}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="num text-meta text-tx-3">{option.band}</span>
              </label>
            </li>
          ))}
        </ul>
        {selected.size > 0 ? (
          <Button
            size="sm"
            className="mt-1 w-full"
            onClick={() => onChange(new Set())}
          >
            Clear filter
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
