import { EmptyState } from "@/components/console/empty-state";
import { Button } from "@/components/ui/button";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import type { SetupPlace } from "./setup-place";
import { TemplateCard } from "./template-card";

/**
 * One page of the catalogue as cards.
 *
 * Each card carries the Template's logo, name, the app's version, description,
 * where it can run, its tags and its links; `TemplateCard` says how it is laid
 * out. One across, and two from `cols` up: below it the rail takes enough of
 * the width that two rows side by side squeeze their descriptions to a few
 * words a line.
 *
 * A page that is empty while the catalogue is not means the filters matched
 * nothing — a different sentence from an empty catalogue, which the card above
 * handles — and it carries the one way out, the same Clear filters the
 * toolbar shows, so the next action is beside the sentence that names it.
 */
export function TemplateGrid({
  templates,
  total,
  onClear,
  place,
}: {
  /** Where each card's setup starts, when opened from an Environment. */
  place?: SetupPlace;
  templates: TemplateSummary[];
  /** Everything in the catalogue, for the sentence when nothing matches. */
  total: number;
  /** Clears the search and the tags, for the empty result's button. */
  onClear?: () => void;
}) {
  if (templates.length === 0) {
    return (
      <EmptyState
        icon="search"
        title="No template matches"
        action={
          onClear ? (
            <Button size="sm" onClick={onClear}>
              Clear filters
            </Button>
          ) : undefined
        }
      >
        Clear filters to see all {total} templates again.
      </EmptyState>
    );
  }

  return (
    <div
      role="group"
      aria-label="Templates"
      className="grid grid-cols-1 gap-3 cols:grid-cols-2"
    >
      {templates.map((template) => (
        <TemplateCard key={template.id} template={template} place={place} />
      ))}
    </div>
  );
}
