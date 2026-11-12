import type {
  TemplateRunsOn,
  TemplateSummary,
} from "@/lib/api/endpoints/templates";

/**
 * Narrowing the catalogue, in the client, because there is nowhere else.
 *
 * `GET /templates` and `GET /templates/tags` take no parameter — no query,
 * no tag, no page, no count. So **every** control on
 * the catalogue toolbar filters a list the browser is already holding, and the
 * pager below it pages that same array. That is stated on the screen's meta strip
 * rather than left to look server-driven: a "1 – 24 of 500" that is really
 * "1 – 24 of the 500 we downloaded" is only a lie if the screen pretends the next
 * page costs a request.
 *
 * It is also why this is a plain module of pure functions: when the route grows a
 * query parameter, these are what get deleted, and no component changes shape.
 */

/** A catalogue tag and how many templates carry it. */
export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Every tag in the catalogue, most used first.
 *
 * Derived from the list rather than read from `GET /templates/tags`, which
 * returns exactly this set without the counts. The count is the part the
 * route cannot give, and a filter list ordered by usage is the difference
 * between a control and a scroll.
 */
export function tagCounts(templates: TemplateSummary[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const template of templates) {
    for (const tag of template.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * The templates matching a search and a set of tags.
 *
 * **The search reads tags too**, and that is deliberate rather than lazy: most
 * of what someone types — "postgres", "monitoring", "ai" — is a tag on
 * something, and a search box that found nothing for a word printed on the
 * cards under it would read as broken. The tag filter is still the precise
 * instrument; the search is the one you reach for first.
 *
 * Several tags means **any** of them, on F08's reasoning: these are labels rather
 * than facets, and "ai" *and* "database" together would usually answer with
 * nothing.
 */
export function filterTemplates(
  templates: TemplateSummary[],
  query: string,
  tags: ReadonlySet<string>,
): TemplateSummary[] {
  const text = query.trim().toLowerCase();

  return templates.filter((template) => {
    if (tags.size > 0 && !template.tags.some((tag) => tags.has(tag))) {
      return false;
    }
    if (text === "") return true;
    return (
      template.name.toLowerCase().includes(text) ||
      template.id.includes(text) ||
      template.description.toLowerCase().includes(text) ||
      template.tags.some((tag) => tag.includes(text))
    );
  });
}

/** How many cards a page of the catalogue holds. */
export const PAGE_SIZE = 24;

/**
 * The where-it-runs mark: a Server always, then the clouds whose Cloud
 * account can make every part of the Template.
 */
export function runsOnMark(runsOn: readonly TemplateRunsOn[]): string {
  const aws = runsOn.includes("aws");
  const gcp = runsOn.includes("gcp");
  if (aws && gcp) return "Runs on a Server or in a cloud";
  if (aws) return "Runs on a Server or on AWS";
  if (gcp) return "Runs on a Server or on Google Cloud";
  return "Runs on a Server";
}
