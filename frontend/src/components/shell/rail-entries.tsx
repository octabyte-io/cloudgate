import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { projectsApi } from "@/lib/api/endpoints/projects";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

import { entryHref, isCurrent, type NavEntry, type NavGroup } from "./nav";
import { RailGroup, RailSubLink, RailSubList } from "./rail-group";
import { RailGroupFlyout } from "./rail-group-flyout";
import { RailLabel, RailLink, RailRule } from "./rail-item";
import { useStarred } from "./favourites";
import { useRailCollapsed } from "./rail-state";
import { useRecents } from "./recents";
import { useScope } from "./scope-provider";
import { useIsDrawer } from "./use-is-drawer";

/**
 * One nav-table entry, rendered.
 *
 * This is the whole of what the rail knows about *what is in* a nav table, which
 * is why it is separable from the rail itself: `scope-rail.tsx` owns the three
 * widths and the two scroll regions, and this owns the four row kinds and where a
 * group's live children come from.
 */

export function RailEntry({
  entry,
  onNavigate,
}: {
  entry: NavEntry;
  onNavigate: () => void;
}) {
  const { scope } = useScope();

  if (entry.kind === "label") return <RailLabel>{entry.label}</RailLabel>;
  if (entry.kind === "rule") return <RailRule />;

  if (entry.kind === "item") {
    return (
      <RailLink
        href={entryHref(scope, entry.tab)}
        icon={entry.icon}
        label={entry.label}
        tag={entry.tag}
        current={isCurrent(scope, entry)}
        onNavigate={onNavigate}
      />
    );
  }

  return <RailGroupEntry entry={entry} onNavigate={onNavigate} />;
}

/**
 * A group and its live children.
 *
 * The open state is a `useState` here rather than in the store, because it is
 * about this rail in this tab right now — and because the rail lives in the
 * console layout, it survives every client navigation without being persisted.
 */
function RailGroupEntry({
  entry,
  onNavigate,
}: {
  entry: Extract<NavEntry, { kind: "group" }>;
  onNavigate: () => void;
}) {
  // The icon strip has no room for a sub-list under the row, so a group
  // that is not also a page opens its items beside the icon instead.
  const collapsed = useRailCollapsed();
  if (collapsed && entry.tab === undefined) {
    return <StripGroupEntry entry={entry} onNavigate={onNavigate} />;
  }
  return <ListGroupEntry entry={entry} onNavigate={onNavigate} />;
}

type GroupEntryProps = {
  entry: Extract<NavEntry, { kind: "group" }>;
  onNavigate: () => void;
};

/**
 * Its own component so that only a collapsed rail asks `useIsDrawer`: a drawer
 * is never the strip, whatever the stored preference says, so it gets the
 * sub-list in place.
 */
function StripGroupEntry({ entry, onNavigate }: GroupEntryProps) {
  const { scope } = useScope();
  const isDrawer = useIsDrawer();
  const [open, setOpen] = useState(false);
  const children = useGroupChildren(entry.source, open && !isDrawer);

  if (isDrawer) return <ListGroupEntry entry={entry} onNavigate={onNavigate} />;

  return (
    <div className="mb-0.5">
      <RailGroupFlyout
        icon={entry.icon}
        label={entry.label}
        current={isCurrent(scope, entry)}
        open={open}
        onOpenChange={setOpen}
        items={children}
        empty={EMPTY[entry.source]}
        onNavigate={onNavigate}
      />
    </div>
  );
}

/** The sub-list under the row: expanded, and in the drawer. */
function ListGroupEntry({ entry, onNavigate }: GroupEntryProps) {
  const { scope } = useScope();
  const [open, setOpen] = useState(false);
  const children = useGroupChildren(entry.source, open);
  const panelId = `rail-group-${entry.id}`;

  return (
    <div className="mb-0.5">
      <RailGroup
        icon={entry.icon}
        label={entry.label}
        href={entry.tab === undefined ? undefined : entryHref(scope, entry.tab)}
        current={isCurrent(scope, entry)}
        open={open}
        onToggle={() => setOpen((was) => !was)}
        panelId={panelId}
        onNavigate={onNavigate}
      />
      {open ? (
        <RailSubList id={panelId}>
          {children.length === 0 ? (
            <p className="py-1.5 text-ui text-tx-3">{EMPTY[entry.source]}</p>
          ) : (
            children.map((child) => (
              <RailSubLink
                key={child.href}
                href={child.href}
                label={child.label}
                current={false}
                onNavigate={onNavigate}
              />
            ))
          )}
        </RailSubList>
      ) : null}
    </div>
  );
}

/** What an open-but-empty group says. Not an error — there is just nothing yet. */
const EMPTY: Record<NavGroup["source"], string> = {
  projects: "No Projects yet.",
  recents: "Nothing visited yet.",
  starred: "Nothing starred yet.",
};

/**
 * A group's children are live data, and the sources are deliberately different
 * kinds of thing: Projects is the Organization's real list, Recents is this
 * browser's history of resources visited (`recents.ts`), and Starred is this
 * browser's bookmarks, made with the star in a resource's header
 * (`favourites.ts`).
 *
 * Neither child is ever the *current* row — clicking one leaves this rail for
 * that resource's own scope, which is the signature working as intended.
 */
function useGroupChildren(
  source: NavGroup["source"],
  open: boolean,
): { href: string; label: string }[] {
  const recents = useRecents();
  const starred = useStarred();
  const { organizationId } = useActiveOrganizationId();

  // Only while the group is open. A rail is on screen for the whole session, and
  // a list nobody has asked to see is not worth a request on every page load —
  // TanStack keeps it once fetched, so opening it twice costs one.
  const projects = useQuery({
    queryKey: keys.projects.list(organizationId),
    queryFn: () => projectsApi.list(),
    enabled: source === "projects" && open && organizationId !== null,
  });

  if (source === "recents" || source === "starred") {
    return (source === "recents" ? recents : starred).map((each) => ({
      href: each.href,
      label: each.label,
    }));
  }
  return (projects.data ?? []).map((each) => ({
    href: `/projects/${each.projectId}`,
    label: each.name,
  }));
}

/** A label or a rule has no id of its own; its position is its identity. */
export function keyOf(entry: NavEntry, index: number): string {
  if (entry.kind === "item") return entry.tab;
  if (entry.kind === "group") return entry.id;
  return `${entry.kind}-${index}`;
}
