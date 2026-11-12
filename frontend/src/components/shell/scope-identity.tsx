import Link from "next/link";
import { Fragment } from "react";

import { Chip } from "@/components/console/chip";
import { Menu } from "@/components/console/menu";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { starOf, toggleStar, useIsStarred, useStarOwner } from "./favourites";
import { scopeRoot } from "./scope";
import { useScope, type ScopeBadge, type ScopeContext } from "./scope-provider";
import { scopePathLabel } from "./scope-title";

/**
 * The resource's identity, in the masthead (e-console.html:2211-2220).
 *
 * A resource scope carries its identity up here *permanently* — which is exactly
 * why the Organization-scope breadcrumb fades in on scroll and this does not.
 * Star, name, badges, and a switcher to sibling resources.
 *
 * At `lbl` and below the badges go: the page header underneath repeats the
 * status and the kind in words, and at that width the name is what matters.
 */
export function ScopeIdentity() {
  const { identity, badges, pending, siblings, scope } = useScope();

  if (!identity) {
    // Pending is a name we do not have yet. Anything else — a 404, a 403 — is
    // the page's story to tell, not the masthead's, so it says nothing.
    return pending ? <Skeleton className="h-4.5 w-40" /> : null;
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.25">
      <StarToggle identity={identity} href={scopeRoot(scope)} />

      {/*
        The parents are links to their own scopes: `ui-main / staging` is
        how a breadcrumb reads, and it was plain text, so the only way up was the
        rail's "Back to …" pill. The current name stays text — it is where you
        are. `title` carries the whole path for when a narrow masthead has
        truncated it.
      */}
      <span
        className="min-w-0 shrink truncate text-body font-semibold text-tx"
        title={identity.parents ? scopePathLabel(identity) : undefined}
      >
        {identity.parents?.map((parent) => (
          <Fragment key={parent.id}>
            <Link
              href={parent.href}
              className="rounded-sm font-medium text-tx-3 underline-offset-3 hover:text-tx hover:underline focus-visible:underline"
            >
              {parent.name}
            </Link>
            <span className="font-medium text-tx-3"> / </span>
          </Fragment>
        ))}
        {identity.name}
      </span>

      {badges.length > 0 ? (
        <span className="flex flex-none items-center gap-1.75 max-lbl:hidden">
          {badges.map((badge) => (
            <Badge key={badgeKey(badge)} badge={badge} />
          ))}
        </span>
      ) : null}

      {siblings ? (
        <Menu
          align="start"
          className="min-w-62.5"
          trigger={
            <button
              type="button"
              aria-label="Switch resource"
              className="grid h-6.5 w-5.5 flex-none place-items-center rounded-md text-tx-3 transition-colors duration-100 hover:bg-raise hover:text-tx"
            >
              <Icon name="chevUD" size={13} />
            </button>
          }
        >
          <Menu.Group label={siblings.label}>
            {siblings.items.map((each) => (
              <Menu.Item
                key={each.id}
                selected={each.id === identity.id}
                render={<Link href={each.href} />}
              >
                {each.name}
              </Menu.Item>
            ))}
          </Menu.Group>
        </Menu>
      ) : null}
    </div>
  );
}

/**
 * A bookmark in this browser, and it says so rather than pretending otherwise:
 * there is no favourites endpoint (`favourites.ts`). What it writes is a row for
 * the Starred list — the path label this header shows, the scope's root,
 * and the Organization it is in — so the list never has to fetch a name.
 */
function StarToggle({
  identity,
  href,
}: {
  identity: NonNullable<ScopeContext["identity"]>;
  href: string | null;
}) {
  const starred = useIsStarred(identity.id);
  const owner = useStarOwner();
  const { organizationId } = useActiveOrganizationId();

  return (
    <button
      type="button"
      onClick={() => {
        if (owner === null || organizationId === null || href === null) return;
        toggleStar(owner, starOf(identity, href, organizationId));
      }}
      aria-pressed={starred}
      aria-label={starred ? `Unstar ${identity.name}` : `Star ${identity.name}`}
      className={cn(
        "grid size-6.5 flex-none place-items-center rounded-md transition-colors duration-100 hover:bg-raise",
        // Starred is a filled star, not only a different hue (rule 5), and in
        // the brand's text tone rather than `--warn`, which means "needs
        // attention" everywhere else in the console.
        starred ? "text-brand-tx [&_svg]:fill-current" : "text-tx-3 hover:text-tx",
      )}
    >
      <Icon name="star" size={15} />
    </button>
  );
}

function Badge({ badge }: { badge: ScopeBadge }) {
  if (badge.kind === "status") return <StatusPill status={badge.status} />;
  if (badge.kind === "mark") return <StatusPill mark={badge.mark} />;
  return <Chip>{badge.label}</Chip>;
}

function badgeKey(badge: ScopeBadge): string {
  if (badge.kind === "status") return `status-${badge.status}`;
  if (badge.kind === "mark") return `mark-${badge.mark.label}`;
  return `chip-${badge.label}`;
}
