import { Chip } from "@/components/console/chip";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { Icon } from "@/lib/design/icons";

import { runsOnMark } from "./catalogue";
import { TemplateHomeLogo, TemplateHomeName } from "./template-home";

const TILE =
  "grid size-16 flex-none place-items-center rounded-xl border border-line bg-panel shadow-panel max-hd:size-12";

const LINKS = [
  ["website", "Website"],
  ["docs", "Docs"],
  ["source", "Source"],
] as const;

/**
 * The setup screen's header: which Template this is, before anything is
 * asked about it.
 *
 * **It replaces the catalogue's "Templates" header** on `?template=<id>`.
 * The setup used to keep the catalogue's title and lede, so nothing above
 * the fold named the app being set up, and its logo, description and links
 * were left behind on the card that was clicked. A template marketplace's
 * detail page (Railway's, Vercel's) opens on the thing itself: its mark, its
 * name, one paragraph and where to read more. This is that, at the console's
 * scale: the `h1` is the Template's name, and every tag is shown in full,
 * because here, unlike in a grid of 500, there is room.
 *
 * **Its logo and name open the Template's website** in a new tab, as they do
 * on the catalogue card (`TemplateHomeName`), so the two agree on what
 * clicking a Template's name does.
 *
 * `template` is the catalogue's entry, read from the copy the catalogue
 * screen already holds; until it arrives the name is the setup form's and
 * the rest is a skeleton. A Template missing from the catalogue (its id was
 * typed) still gets its name.
 */
export function TemplateIntro({
  template,
  fallbackName,
  pending,
  back = "/templates",
}: {
  /** The catalogue to go back to, keeping where it was opened from. */
  back?: string;
  template: TemplateSummary | undefined;
  fallbackName: string;
  pending: boolean;
}) {
  const links = template ? LINKS.filter(([key]) => template.links[key]) : [];

  return (
    <header className="mb-5.5 grid gap-4">
      <div>
        <LinkButton href={back} size="sm" variant="qt" className="-ml-2.5">
          <Icon name="back" size={14} />
          All templates
        </LinkButton>
      </div>
      <div className="flex min-w-0 items-start gap-4">
        {template ? (
          <TemplateHomeLogo template={template} className={TILE}>
            {/* A `data:` address from the catalogue file, so no request and
                no script, hence a plain `<img>` (see `TemplateCard`). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={template.logo}
              alt=""
              className="size-10 object-contain max-hd:size-7.5"
            />
          </TemplateHomeLogo>
        ) : (
          <span className={TILE}>
            <Icon name="book" size={24} className="text-tx-4" />
          </span>
        )}
        <div className="grid min-w-0 flex-1 gap-1.75">
          <div className="flex flex-wrap items-baseline gap-x-2.75 gap-y-1">
            <h1 className="text-disp wrap-anywhere text-tx max-hd:text-sect">
              {template ? (
                <TemplateHomeName template={template}>
                  {template.name}
                </TemplateHomeName>
              ) : (
                fallbackName
              )}
            </h1>
            {template?.version ? (
              <Chip variant="mono">{template.version}</Chip>
            ) : null}
          </div>
          {template ? (
            <>
              <p className="max-w-lede text-body text-tx-2">
                {template.description}
              </p>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-tx-2">
                <span className="inline-flex items-center gap-1">
                  <Icon
                    name={template.runsOn.length > 1 ? "cloud" : "server"}
                    size={13}
                    className="text-tx-3"
                  />
                  {runsOnMark(template.runsOn)}
                </span>
                {links.map(([key, label]) => (
                  <a
                    key={key}
                    href={template.links[key]}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 rounded-sm underline-offset-2 transition-colors duration-100 hover:text-tx hover:underline focus-visible:underline"
                  >
                    {label}
                    <Icon name="ext" size={12} />
                  </a>
                ))}
              </p>
              {template.tags.length > 0 ? (
                <ul
                  aria-label="Tags"
                  className="flex max-w-lede flex-wrap gap-1.5"
                >
                  {template.tags.map((tag) => (
                    <li key={tag}>
                      <Chip>{tag}</Chip>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : pending ? (
            <Skeleton className="h-10 max-w-lede" />
          ) : null}
        </div>
      </div>
    </header>
  );
}
