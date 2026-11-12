import Link from "next/link";

import { BrandMark } from "@/components/console/brand-mark";
import { useBrandingOrDefault } from "@/lib/api/use-branding";
import { brandName } from "@/lib/branding/branding";
import { Icon } from "@/lib/design/icons";

import { AvatarMenu } from "./avatar-menu";
import { MastheadCrumb } from "./masthead-crumb";
import { OrgSwitcher } from "./org-switcher";
import { ScopeIdentity } from "./scope-identity";
import { useScope } from "./scope-provider";

/**
 * The masthead (e-console.html:209-293).
 *
 * Three cells: the Organization cell whose width tracks the rail's, the context
 * area, and the actions. The context area shows **either** the breadcrumb that
 * fades in on scroll (Organization scope) **or** the resource's identity — never
 * both, because a resource scope already carries its identity up here
 * permanently and a crumb under it would say the same thing twice.
 *
 * The shedding order at `lbl` (820px) is the reference's and it is deliberate:
 * labels go before controls. The resource's badges go because the page header
 * repeats them in words, and the breadcrumb goes entirely because the page
 * title is right underneath it. The logotype drops to its glyph; the
 * Organization name stays, truncated.
 */
export type MastheadProps = {
  /** Whether `<main>` has scrolled — the only thing the breadcrumb waits for. */
  scrolled: boolean;
  /** Below the `rail` breakpoint the rail is a drawer and needs a way in. */
  isDrawer: boolean;
  drawerOpen: boolean;
  /** Where focus returns when the drawer is dismissed. */
  drawerToggleRef?: React.Ref<HTMLButtonElement>;
  onDrawerToggle: () => void;
};

export function Masthead({
  scrolled,
  isDrawer,
  drawerOpen,
  drawerToggleRef,
  onDrawerToggle,
}: MastheadProps) {
  const { identity, pending } = useScope();
  const atOrganization = identity === null && !pending;
  const branding = useBrandingOrDefault();

  return (
    <header className="relative z-30 flex min-w-0 items-stretch border-b border-line bg-panel">
      {/* `overflow-hidden` is a backstop, not a layout: the cell's width tracks
          the rail's, and at the 60px icon strip its contents would otherwise
          spill into the context area and print the wordmark over the resource's
          name. Everything inside sheds deliberately below; this is what makes a
          missed case clip instead of collide.

          The width is the rail's *at least*: a name that does not fit
          beside the logotype grows the cell, up to two fifths of the masthead,
          into the context area's spare room, rather than truncating on day one
          ("My Organizati…"). On the strip it is exactly the strip; as a drawer
          the cell is its content, up to half the masthead, and shrinks first,
          so the name truncates before the resource's identity or the actions
          do. */}
      <div className="flex w-max max-w-2/5 min-w-(--rail-w) flex-none items-center gap-2 overflow-hidden border-r border-line pr-3 pl-4 transition-[width] duration-150 railc:w-(--rail-w) railc:max-w-(--rail-w) railc:gap-1 railc:pr-1.5 railc:pl-2 max-rail:w-auto max-rail:max-w-1/2 max-rail:min-w-0 max-rail:flex-initial max-rail:border-r-0 max-rail:pr-1 max-rail:pl-2.5">
        {isDrawer ? (
          <button
            ref={drawerToggleRef}
            type="button"
            onClick={onDrawerToggle}
            aria-label={drawerOpen ? "Hide navigation" : "Show navigation"}
            aria-expanded={drawerOpen}
            aria-controls="scope-rail"
            className="grid size-7.5 flex-none place-items-center rounded-sm text-tx-3 transition-colors duration-100 hover:bg-raise hover:text-tx"
          >
            <Icon name="panel" size={17} />
          </button>
        ) : null}

        <Link
          href="/"
          aria-label={`${brandName(branding)} — Organization home`}
          className="flex flex-none items-center gap-2 rounded-sm"
        >
          {/* The glyph is the mark on its own at 60px. The link's `aria-label`
              is what names it, so hiding the word costs nothing but width —
              which is why it, and not the Organization's name, is what goes
              below `lbl`.
              Shared with the auth screens (F06) so there is one logotype,
              and branded with them. */}
          <BrandMark wordClassName="railc:hidden max-lbl:hidden" />
        </Link>

        <OrgSwitcher />
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        {atOrganization ? (
          <MastheadCrumb scrolled={scrolled} />
        ) : (
          <ScopeIdentity />
        )}
      </div>

      <div className="flex flex-none items-center gap-0.5 pr-3 pl-2">
        <AvatarMenu />
      </div>
    </header>
  );
}
