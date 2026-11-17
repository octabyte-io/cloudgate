import { Chip } from "@/components/console/chip";
import { LinkButton } from "@/components/console/link-button";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { Icon } from "@/lib/design/icons";

import { runsOnMark } from "./catalogue";
import { NO_PLACE, templatesHref, type SetupPlace } from "./setup-place";

const LINKS = [
  ["website", "Website"],
  ["docs", "Docs"],
  ["source", "Source"],
] as const;

/** Whether a Template runs on a Server and in both clouds, as most do. */
function everywhere(template: TemplateSummary): boolean {
  return template.runsOn.includes("aws") && template.runsOn.includes("gcp");
}

/**
 * One Template in the catalogue, as a wide row: the logo on the left, the
 * text in the middle, and Set up on the top right where the eye ends the
 * name. `TemplateGrid` sets them one across, and two across from `cols` up.
 *
 * **A row rather than a narrow tile** because a Template is read before it is
 * picked: its description is the deciding fact, and at four across it was cut
 * to three short lines while the tags wrapped to as many as three rows and set
 * Set up at a different height on every card. As a row, the description gets
 * two full-width lines and the tags one line.
 *
 * **The logo sits on a tile** rather than bare beside the name: catalogue
 * logos are any shape and colour, and a 24px mark next to 14px text read as an
 * icon glitch. It is a `data:` address from the backend, read out of the
 * catalogue file, so the card makes no request of its own and an SVG logo
 * runs no script — hence a plain `<img>` rather than `next/image`.
 *
 * **Whole tags on one line.** As many chips as fit, each in full; the rest
 * wrap below the line and are clipped, so every card in a row is the same
 * height. Truncated chips ("web a…", "no-c…") with a count read as noise and
 * named nothing. The tag filter lists them all, the search matches every tag,
 * and the setup screen shows them in full.
 *
 * **Where it runs only when it is the exception.** Nearly every Template runs
 * on a Server or in either cloud, and the same line on every card was read
 * once and then skipped; a Template a cloud cannot make says so.
 *
 * An `<article>`, not a link: its website, docs and source links live inside
 * it, and a link cannot hold links. **No hover on the card itself** for the
 * same reason — the Set up button and the links are what answer the pointer.
 */
export function TemplateCard({
  template,
  place = NO_PLACE,
}: {
  template: TemplateSummary;
  /** Opened from an Environment, its setup starts there too. */
  place?: SetupPlace;
}) {
  const { tags } = template;

  return (
    <article
      aria-label={template.name}
      className="flex min-w-0 gap-3.5 rounded-xl border border-line bg-panel p-4 shadow-panel"
    >
      <span className="grid size-11 flex-none place-items-center rounded-lg border border-line bg-panel-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={template.logo} alt="" className="size-6.5 object-contain" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-body font-semibold text-tx">
                {template.name}
              </span>
              {template.version ? (
                <span className="truncate font-mono text-meta text-tx-3">
                  {template.version}
                </span>
              ) : null}
            </span>
            {everywhere(template) ? null : (
              <span className="flex min-w-0 items-start gap-1 text-meta text-tx-3">
                <Icon name="server" size={13} className="mt-0.5 flex-none" />
                <span>{runsOnMark(template.runsOn)}</span>
              </span>
            )}
          </span>
          <LinkButton
            href={templatesHref(place, template.id)}
            size="sm"
            className="flex-none"
            aria-label={`Set up ${template.name}`}
          >
            Set up
          </LinkButton>
        </div>

        <p className="line-clamp-2 text-meta wrap-anywhere text-tx-2">
          {template.description}
        </p>

        {/* Pushed to the bottom edge, so in a row of two the tags and links of
            both cards sit on the same line whatever their descriptions. */}
        <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {tags.length > 0 ? (
            // Whole chips on one line: the ones that do not fit wrap below
            // it, out of sight, and the tag filter lists them all.
            <ul
              aria-label="Tags"
              title={tags.join(", ")}
              className="flex h-chip min-w-0 flex-1 basis-48 flex-wrap gap-1 overflow-hidden"
            >
              {tags.map((tag) => (
                <li key={tag} className="flex">
                  <Chip>{tag}</Chip>
                </li>
              ))}
            </ul>
          ) : null}
          {LINKS.some(([key]) => template.links[key]) ? (
            <span className="flex flex-none gap-3 text-meta">
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
        </div>
      </div>
    </article>
  );
}
