import { useMemo, useRef } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Pager } from "@/components/console/pager";
import { PickGrid } from "@/components/console/pick-card";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type {
  CatalogueCopy,
  TemplateSummary,
} from "@/lib/api/endpoints/templates";
import { Icon } from "@/lib/design/icons";
import { timeAgo, timeExact } from "@/lib/format/time";

import { filterTemplates, PAGE_SIZE, tagCounts } from "./catalogue";
import { CatalogueToolbar } from "./catalogue-toolbar";
import { TemplateGrid } from "./template-grid";

/**
 * The Template catalogue, narrowed by search and by tag.
 *
 * **A `PickGrid` of `PickCard`s, and no new card component** — a template is
 * a pick, not a marketing tile. The description is clamped to three lines
 * (`descriptionLines`) so one long one does not set the height of its row.
 *
 * **The saved copy's note.** The backend keeps the last good catalogue and
 * serves it when a check fails (unreachable, or a newer file refused), saying
 * why in `copy.problem`; this screen says so and how old the copy is, so an
 * outage reads as an outage rather than as the catalogue's current state.
 *
 * The pager pages an array the browser already holds: there is no server-side
 * filtering of any kind here.
 */
export function CatalogueView({
  templates,
  copy,
  pending,
  error,
  onRetry,
  query,
  onQuery,
  tags,
  onTags,
  page,
  onPage,
}: {
  templates: TemplateSummary[];
  /** The saved copy the list came from; absent until it has arrived. */
  copy?: CatalogueCopy;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  query: string;
  onQuery: (next: string) => void;
  tags: ReadonlySet<string>;
  onTags: (next: Set<string>) => void;
  page: number;
  onPage: (next: number) => void;
}) {
  const counts = useMemo(() => tagCounts(templates), [templates]);
  const shown = useMemo(
    () => filterTemplates(templates, query, tags),
    [templates, query, tags],
  );

  const filtering = query.trim() !== "" || tags.size > 0;
  const from = page * PAGE_SIZE;
  const visible = shown.slice(from, from + PAGE_SIZE);

  const grid = useRef<HTMLElement>(null);

  /**
   * Paging brings the top of the grid back into view: the pager sits under 24
   * cards, so pressing Next without this leaves the reader at the *bottom* of
   * the new page. Done in the handler rather than an effect so it happens on
   * the gesture and not on every render that changes `page`.
   */
  function turn(to: number) {
    onPage(to);
    grid.current?.scrollIntoView({ block: "start" });
  }

  return (
    <>
      <CatalogueToolbar
        query={query}
        onQuery={onQuery}
        tags={tags}
        counts={counts}
        onTags={onTags}
        onPage={onPage}
        disabled={!pending && templates.length === 0}
      />

      <Card className="mt-4" ref={grid}>
        {pending ? (
          <Card.Body>
            <PickGrid label="Templates loading" aria-busy="true">
              {[0, 1, 2, 3, 4, 5].map((slot) => (
                <Skeleton key={slot} className="h-28 rounded-xl" />
              ))}
            </PickGrid>
          </Card.Body>
        ) : isApiError(error) && error.isCatalogueNotConfigured ? (
          /**
           * **Templates are off, which is not an outage and not an empty
           * catalogue.** The backend's message says which setting turned them
           * off and what to set. No "Try again": the answer cannot change
           * until the backend is restarted with other settings.
           */
          <Card.Body>
            <EmptyState icon="book" title="Templates are off">
              {errorMessage(error)}
            </EmptyState>
          </Card.Body>
        ) : error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(error)}</p>
            <Button className="mt-3" onClick={onRetry}>
              <Icon name="refresh" size={15} />
              Try again
            </Button>
          </Card.Body>
        ) : templates.length === 0 ? (
          /**
           * **An empty catalogue, and only that.** An unreachable one with no
           * saved copy is a 502 or 504, which the `error` branch above
           * renders, so an empty list reaching here is the catalogue's own
           * answer: no template in it, or none this Cloudgate can read.
           */
          <Card.Body>
            <EmptyState
              icon="book"
              title="The catalogue is empty"
              action={
                <Button size="sm" onClick={onRetry}>
                  <Icon name="refresh" size={15} />
                  Try again
                </Button>
              }
            >
              The catalogue offers no template this instance can read.
            </EmptyState>
          </Card.Body>
        ) : (
          <>
            <MetaStrip>
              {filtering ? (
                <>
                  <strong>{shown.length}</strong> of{" "}
                  <strong>{templates.length}</strong> templates match.
                </>
              ) : (
                <>
                  <strong>{templates.length}</strong> templates in the
                  catalogue.
                </>
              )}
            </MetaStrip>

            {copy?.problem ? <StaleCopyNote copy={copy} /> : null}

            <Card.Body>
              {/*
                Keyed by the page and the tags, so turning a page or ticking a
                tag fades the new set in where the old one stood — and the
                catalogue arriving after its skeleton does the same. Not by the
                search: that changes on every keystroke, and typing does not
                animate.
              */}
              <div key={`${page}|${[...tags].join(",")}`} className="animate-fade">
                <TemplateGrid
                  templates={visible}
                  total={templates.length}
                  onClear={() => {
                    onQuery("");
                    onTags(new Set());
                    onPage(0);
                  }}
                />
              </div>
            </Card.Body>

            {shown.length > PAGE_SIZE ? (
              <Pager
                shown={visible.length}
                total={shown.length}
                noun="templates"
                from={from + 1}
                onPrevious={() => turn(Math.max(0, page - 1))}
                onNext={() => turn(page + 1)}
              />
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}

/**
 * The last check failed and an older copy is shown: why, and how old it is.
 * `role="status"` so it is read out with the list it qualifies.
 */
function StaleCopyNote({ copy }: { copy: CatalogueCopy }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 border-b border-line px-4 py-2.75 text-meta text-tx-2"
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-warn" />
      <span>
        {copy.problem}. Showing the copy fetched{" "}
        <time dateTime={copy.fetchedAt} title={timeExact(copy.fetchedAt)}>
          {timeAgo(copy.fetchedAt)}
        </time>
        .
      </span>
    </p>
  );
}
