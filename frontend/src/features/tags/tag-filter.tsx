import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Tag } from "@/lib/api/endpoints/tags";
import { Icon } from "@/lib/design/icons";

/**
 * Narrow a list of Projects to the Tags it carries.
 *
 * A popover of checkboxes rather than a `Menu`, for one reason: a menu closes
 * when a row is chosen, and choosing two Tags is the ordinary case. The trigger
 * says how many are on, so the filter is legible with the popover shut — a
 * filtered list that looks unfiltered is how someone concludes their Projects
 * have vanished.
 *
 * Several Tags means **any** of them, not all. Tags here are labels rather than
 * facets, and a Project rarely carries two of the ones you would pick together;
 * requiring all of them would usually answer with nothing. The trigger's own
 * word is "Tags", and the count says how many are on.
 */
export function TagFilter({
  tags,
  selected,
  onChange,
}: {
  tags: Tag[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  function toggle(tagId: string, on: boolean) {
    const draft = new Set(selected);
    if (on) draft.add(tagId);
    else draft.delete(tagId);
    onChange(draft);
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label={`Filter by tag, ${selected.size} selected`}>
            <Icon name="filter" size={15} />
            Tags
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
        className="max-h-pal-list w-64 overflow-auto rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0"
      >
        {tags.length === 0 ? (
          <p className="px-2.25 py-2 text-body text-tx-2">
            No tags yet. Add one from Manage tags to start grouping Projects.
          </p>
        ) : (
          <ul className="flex flex-col">
            {tags.map((tag) => (
              <li key={tag.tagId}>
                <label className="flex h-8 cursor-pointer items-center gap-2.25 rounded-md px-2.25 text-body text-tx transition-colors duration-100 ease-out-strong hover:bg-raise">
                  <Checkbox
                    checked={selected.has(tag.tagId)}
                    onCheckedChange={(next) => toggle(tag.tagId, next === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {/* Outside the branch above: the way out of a filter does not
            depend on the Organization still having a Tag to list. */}
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
