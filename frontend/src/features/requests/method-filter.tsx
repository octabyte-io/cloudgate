import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/lib/design/icons";

/**
 * Narrow the request log to one or more HTTP methods.
 *
 * **A real filter now, and only because the route grew one.** The screen shipped
 * without this on purpose: a method filter applied in the browser would have
 * narrowed the 50 rows on screen out of several thousand in the window and
 * printed a count that was true of the page and false of the traffic. `method[]`
 * on `POST /monitoring/requests/logs`
 * filters the whole window before paging, so the count under the table means
 * what it says. This control sends that field and nothing else changes.
 *
 * Built on `StatusFilter`, unchanged: a popover of checkboxes rather than a menu,
 * because asking for POST *and* PUT is the ordinary case and a menu closes on the
 * first; several methods means **any** of them, which is what the backend does;
 * and the count rides on the trigger so a filtered log never looks unfiltered.
 *
 * **The two groups are the question being asked.** The reason to filter by method
 * is to tell a broken form from a crawler — writes from reads — so the list is
 * split that way rather than left alphabetical. It is the same move as the status
 * bands: the grouping is the information, not decoration on top of it.
 *
 * **Seven verbs, and the route accepts more.** Traefik logs whatever the client
 * sent, so a window can hold a `TRACE` or a `PROPFIND` that this list cannot ask
 * for. That is a real gap and a small one — naming every verb in a checkbox list
 * to cover the ones nobody filters for would cost more than it buys, and the
 * Method column still shows them.
 */

/** The verbs on offer, grouped by whether they change anything. */
export const METHOD_GROUPS: { label: string; methods: string[] }[] = [
  { label: "Reads", methods: ["GET", "HEAD", "OPTIONS"] },
  { label: "Writes", methods: ["POST", "PUT", "PATCH", "DELETE"] },
];

export function MethodFilter({
  selected,
  onChange,
}: {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  function toggle(method: string, on: boolean) {
    const draft = new Set(selected);
    if (on) draft.add(method);
    else draft.delete(method);
    onChange(draft);
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label={`Filter by method, ${selected.size} selected`}>
            <Icon name="filter" size={15} />
            Method
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
        className="w-56 rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0"
      >
        {METHOD_GROUPS.map((group) => (
          <div key={group.label} className="mt-1.5 first:mt-0">
            {/* The heading names the group for a reader and for a screen
                reader — the list below it is `aria-labelledby` this, so the
                verbs are not seven ungrouped checkboxes in the accessibility
                tree either. */}
            <p
              id={`method-group-${group.label}`}
              className="px-2.25 pb-1 text-meta font-medium text-tx-3"
            >
              {group.label}
            </p>
            <ul
              aria-labelledby={`method-group-${group.label}`}
              className="flex flex-col"
            >
              {group.methods.map((method) => (
                <li key={method}>
                  <label className="flex h-8 cursor-pointer items-center gap-2.25 rounded-md px-2.25 text-body text-tx hover:bg-raise">
                    <Checkbox
                      checked={selected.has(method)}
                      onCheckedChange={(next) => toggle(method, next === true)}
                    />
                    <span className="num min-w-0 flex-1 truncate">
                      {method}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {selected.size > 0 ? (
          <Button
            size="sm"
            className="mt-1.5 w-full"
            onClick={() => onChange(new Set())}
          >
            Clear filter
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
