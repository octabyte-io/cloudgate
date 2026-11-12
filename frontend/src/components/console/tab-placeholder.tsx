import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * A tab of a resource scope, before the phase that fills it.
 *
 * **F07 ships one of these for every tab in the registry**, which is what makes
 * the whole route tree clickable — five scope rails, twenty-six tabs, no dead
 * ends — before a single feature exists. A Wave 4 session replaces the *contents*
 * of its own panel file and never edits the registry or a route.
 *
 * It says so plainly rather than dressing up as an empty state: an empty state
 * is an invitation to act, and there is nothing here to act on yet
 * (`e-console.html` has no vocabulary for "not written yet", and `--hatch` means
 * "does not exist", which is a claim about the product rather than about us).
 *
 * The `<h1>` and the lede come from the registry entry, handed down as props, so
 * the page title, the rail row that led here and the document title are one
 * declaration and cannot disagree.
 */
export function TabPlaceholder({
  label,
  icon,
  phase,
}: Pick<PanelProps, "label" | "icon"> & {
  /** Which phase builds it — a reader of this screen should not have to guess. */
  phase: string;
}) {
  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={`This screen is built in phase ${phase}.`}
      />
    </Page>
  );
}
