import { useState } from "react";

import { SearchInput } from "@/components/console/search-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/lib/design/icons";

import type { TagCount } from "./catalogue";

/**
 * Narrow the catalogue to the tags a template carries.
 *
 * **Deliberately not F08's `TagFilter`, and the difference is scale rather than
 * taste.** That one lists an Organization's Project tags — three of them on the
 * screen it was built for — as a flat column of checkboxes, which is exactly right
 * for three and unusable for the catalogue's **599**. What this adds is the two
 * things 599 needs and three does not: a search over the tag names themselves, and
 * an ordering by how many templates carry each one, so the top of the list is
 * `self-hosted` (147), `monitoring` (44), `database` (39) rather than whatever is
 * alphabetically first. F08's remains the right control at its own scale; a shared
 * component that grew a search field for one caller would put one in front of
 * three checkboxes for the other.
 *
 * Everything else is F08's and for F08's reasons: a popover rather than a `Menu`,
 * because choosing two tags is ordinary and a menu closes on the first; several
 * tags means **any** of them; and the count rides on the trigger, because a
 * filtered list that looks unfiltered is how someone concludes the catalogue has
 * shrunk.
 */
const SHOWN = 100;

export function TemplateTagFilter({
  tags,
  selected,
  onChange,
  disabled = false,
}: {
  tags: TagCount[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Off while there is no catalogue to read tags from. */
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();

  const matching = tags.filter(
    (entry) => text === "" || entry.tag.includes(text),
  );
  // The chosen ones stay visible whatever is typed: a checked box that scrolls out
  // of existence when you search for the second tag reads as having been cleared.
  const listed = [
    ...matching.filter((entry) => selected.has(entry.tag)),
    ...matching.filter((entry) => !selected.has(entry.tag)),
  ].slice(0, SHOWN);
  const hidden = matching.length - listed.length;

  function toggle(tag: string, on: boolean) {
    const draft = new Set(selected);
    if (on) draft.add(tag);
    else draft.delete(tag);
    onChange(draft);
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Filter by tag, ${selected.size} selected`}
            disabled={disabled}
          >
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
        className="w-72 rounded-xl border border-line bg-panel p-1.5 shadow-pop ring-0"
      >
        <div className="p-1">
          <SearchInput
            label="Search tags"
            placeholder="Search tags"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            wrapperClassName="basis-auto"
          />
        </div>

        {tags.length === 0 ? (
          <p className="px-2.25 py-2 text-body text-tx-2">
            No tags — the catalogue has not been read yet.
          </p>
        ) : listed.length === 0 ? (
          <p className="px-2.25 py-2 text-body text-tx-2">
            No tag matches that.
          </p>
        ) : (
          <ul className="max-h-pal-list flex flex-col overflow-auto">
            {listed.map((entry) => (
              <li key={entry.tag}>
                <label className="flex h-8 cursor-pointer items-center gap-2.25 rounded-md px-2.25 text-body text-tx hover:bg-raise">
                  <Checkbox
                    checked={selected.has(entry.tag)}
                    onCheckedChange={(next) => toggle(entry.tag, next === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.tag}</span>
                  <span className="num flex-none text-meta text-tx-3">
                    {entry.count}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {/* Said out loud rather than silently truncated: a list that stops at 100
            with no note reads as the whole of what matched. Two sentences, because
            an unsearched list is showing the *most used* of 599 and a searched one
            is showing the first 100 of what matched — and "499 more match" is a
            strange thing to say to somebody who has not asked anything yet. */}
        {hidden > 0 ? (
          <p className="px-2.25 py-2 text-meta text-tx-3">
            {text === ""
              ? `The ${SHOWN} most used, of ${tags.length}. Type to reach the rest.`
              : `${hidden} more match. Type to narrow them.`}
          </p>
        ) : null}

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
