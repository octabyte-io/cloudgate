import { Chip } from "@/components/console/chip";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Button } from "@/components/ui/button";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { Icon } from "@/lib/design/icons";

import { runsOnMark } from "./catalogue";

const LINKS = [
  ["website", "Website"],
  ["docs", "Docs"],
  ["source", "Source"],
] as const;

/**
 * One page of the catalogue as cards.
 *
 * Each card carries the Template's logo, name, the app's version, description,
 * where it can run, its tags and its links. **The logo is a `data:` address
 * from the backend**, which read it out of the catalogue file, so a card makes
 * no request of its own and an SVG logo runs no script.
 *
 * A card is an `<article>` rather than a link while there is nothing to open:
 * its own website, docs and source links live inside it, and a link cannot
 * hold links.
 *
 * **Three tags per card, not all of them**: a card that wraps to four rows of
 * chips sets the height of every card in its row. The overflow is counted
 * rather than dropped silently.
 *
 * A page that is empty while the catalogue is not means the filters matched
 * nothing — a different sentence from an empty catalogue, which the card above
 * handles — and it carries the one way out, the same Clear filters the
 * toolbar shows, so the next action is beside the sentence that names it.
 *
 * **No hover on the card itself.** It is an `<article>`, not a target: the
 * Set up button and the links inside it are what answer the pointer, and a
 * card that lit up on hover would promise a click that does nothing.
 */
export function TemplateGrid({
  templates,
  total,
  onClear,
}: {
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
    <PickGrid label="Templates">
      {templates.map((template) => (
        <PickCard
          key={template.id}
          render={<article aria-label={template.name} />}
          title={
            <span className="flex items-center gap-2">
              {/* A plain `<img>`, not `next/image`: a `data:` address from the
                  catalogue file, with nothing to optimise or fetch. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={template.logo}
                alt=""
                className="size-6 flex-none rounded-sm object-contain"
              />
              <span className="min-w-0">{template.name}</span>
            </span>
          }
          description={template.description}
          descriptionLines={3}
          meta={template.version ?? undefined}
          footer={
            <span className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1 text-meta text-tx-2">
                <Icon
                  name={template.runsOn.length > 1 ? "cloud" : "server"}
                  size={13}
                />
                {runsOnMark(template.runsOn)}
              </span>
              <span className="flex flex-wrap gap-1">
                {template.tags.slice(0, 3).map((tag) => (
                    <Chip key={tag} className="max-w-full">
                    <span className="truncate">{tag}</span>
                  </Chip>
                ))}
                {template.tags.length > 3 ? (
                  <span className="self-center text-meta text-tx-3">
                    +{template.tags.length - 3}
                  </span>
                ) : null}
              </span>
              <span>
                <LinkButton
                  href={`/templates?template=${encodeURIComponent(template.id)}`}
                  size="xs"
                  aria-label={`Set up ${template.name}`}
                >
                  Set up
                </LinkButton>
              </span>
              {LINKS.some(([key]) => template.links[key]) ? (
                <span className="flex flex-wrap gap-3 text-meta">
                  {LINKS.map(([key, label]) => {
                    const href = template.links[key];
                    return href ? (
                      <a
                        key={key}
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-0.5 rounded-sm text-tx-2 underline-offset-2 transition-colors duration-100 hover:text-tx hover:underline focus-visible:underline"
                      >
                        {label}
                        <Icon name="ext" size={12} />
                      </a>
                    ) : null;
                  })}
                </span>
              ) : null}
            </span>
          }
        />
      ))}
    </PickGrid>
  );
}
