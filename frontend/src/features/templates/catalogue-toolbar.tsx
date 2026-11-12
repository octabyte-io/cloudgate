import { SearchInput } from "@/components/console/search-input";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import { Button } from "@/components/ui/button";

import type { TagCount } from "./catalogue";
import { TemplateTagFilter } from "./tag-filter";

/**
 * Search and tags, and the reset that only appears when there is something to reset.
 *
 * **Every control returns to the first page.** The catalogue arrives whole and is
 * filtered here, so a filter change while on page four would page through a result
 * set that no longer exists.
 */
export function CatalogueToolbar({
  query,
  onQuery,
  tags,
  counts,
  onTags,
  onPage,
  disabled = false,
}: {
  query: string;
  onQuery: (query: string) => void;
  tags: ReadonlySet<string>;
  /** Every tag in the catalogue with how many templates carry it. */
  counts: TagCount[];
  onTags: (tags: Set<string>) => void;
  onPage: (page: number) => void;
  /**
   * Nothing to search: no catalogue is configured, it could not be read, or it
   * is empty. The controls stay in place, off, rather than inviting a search
   * that can only find nothing.
   */
  disabled?: boolean;
}) {
  const filtering = query.trim() !== "" || tags.size > 0;

  return (
    <Toolbar>
      <SearchInput
        label="Search templates"
        placeholder="Search templates"
        value={query}
        disabled={disabled}
        onChange={(event) => {
          onQuery(event.target.value);
          onPage(0);
        }}
      />
      <TemplateTagFilter
        tags={counts}
        selected={tags}
        disabled={disabled}
        onChange={(next: Set<string>) => {
          onTags(next);
          onPage(0);
        }}
      />
      <ToolbarGap />
      {filtering ? (
        <Button
          onClick={() => {
            onQuery("");
            onTags(new Set());
            onPage(0);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </Toolbar>
  );
}
