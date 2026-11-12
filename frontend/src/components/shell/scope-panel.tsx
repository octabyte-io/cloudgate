"use client";

import { LinkButton } from "@/components/console/link-button";
import { Outcome } from "@/components/console/outcome";
import { absentReason, isTabScope, tabEntry } from "@/lib/shell/tab-registry";

import { scopeRoot, type ScopeKind } from "./scope";
import { useScope } from "./scope-provider";

/**
 * The body of every resource scope: whichever tab the URL names, or the
 * statement that the URL names nothing.
 *
 * **This is the whole of a scope shell.** The masthead already carries the
 * resource's identity and the rail already carries its tabs (both from
 * `useScope()`), so what is left for the page is one lookup in the registry.
 * That is why there is one of these rather than five hand-written shells: a
 * shell that holds no feature logic has nothing to differ about.
 *
 * It takes **no props**. The scope, the id and the engine all come from the same
 * pure read of the URL the rail used (`scope.ts`), so the panel cannot be handed
 * an id the masthead disagrees with. The route file's job is only to 404 an
 * invented tab *on the server*, where the status code still exists.
 */
export function ScopePanel() {
  const { scope, missing, nav, pending, subject } = useScope();

  if (missing || scope.id === null) {
    return <ScopeNotFound kind={scope.kind} />;
  }

  const entry = isTabScope(scope.kind) ? tabEntry(scope.kind, scope.tab) : null;
  // Unreachable through a route: the page checked this against the same table
  // before rendering. Kept because "unreachable" and "cannot happen" are not the
  // same sentence, and a blank screen is the worst way to find out which.
  if (!entry) return <ScopeNotFound kind={scope.kind} />;

  // A declared tab this row does not have: an AI model's Domains, a
  // plain Application's Model, a Docker image's Patches. The route
  // could not know — it answers before the row is read — so the rail is the
  // judge, once the row is in, and the tab's own entry says why.
  const offered = nav.some(
    (row) => row.kind === "item" && row.tab === scope.tab,
  );
  if (!pending && !offered) {
    return (
      <TabNotHere
        noun={scope.kind === "organization" ? "page" : NOT_HERE[scope.kind].noun}
        label={entry.label}
        reason={absentReason(entry, subject)}
        href={scopeRoot(scope) ?? "/"}
      />
    );
  }

  const Panel = entry.panel;
  return (
    <Panel
      id={scope.id}
      kind={scope.variant}
      label={entry.label}
      icon={entry.icon}
    />
  );
}

/** A tab this resource is not the kind to have, and why. */
function TabNotHere({
  noun,
  label,
  reason,
  href,
}: {
  /** "Application", "database", "Compose stack" (the latter two have
   *  a tab that can be absent). */
  noun: string;
  label: string;
  reason: string | null;
  href: string;
}) {
  return (
    <Outcome
      tone="info"
      icon="info"
      title={`This ${noun} has no ${label} tab.`}
      action={
        <LinkButton href={href} variant="pri">
          Go to Overview
        </LinkButton>
      }
    >
      {reason ??
        `It is not one this ${noun} has. Overview lists what it does have.`}
    </Outcome>
  );
}

/**
 * What each scope is called and where to go instead.
 *
 * Every service goes back to Projects rather than to its own Environment: the
 * Environment's id came from the same URL that turned out to be wrong, and
 * offering a second link that might also 404 is worse than offering one that
 * cannot.
 */
const SERVERS = { list: "Servers", href: "/servers" };
const PROJECTS = { list: "Projects", href: "/projects" };

const NOT_HERE: Record<
  Exclude<ScopeKind, "organization">,
  { noun: string; list: string; href: string }
> = {
  server: { noun: "Server", ...SERVERS },
  project: { noun: "Project", ...PROJECTS },
  environment: { noun: "Environment", ...PROJECTS },
  application: { noun: "Application", ...PROJECTS },
  database: { noun: "database", ...PROJECTS },
  compose: { noun: "Compose stack", ...PROJECTS },
};

function ScopeNotFound({ kind }: { kind: ScopeKind }) {
  if (kind === "organization") return null;
  const here = NOT_HERE[kind];

  return (
    <Outcome
      tone="info"
      icon="search"
      title={`That ${here.noun} is not here.`}
      action={
        <LinkButton href={here.href} variant="pri">
          Go to {here.list}
        </LinkButton>
      }
    >
      It may have been deleted, or the address may belong to another
      Organization. {here.list} lists everything you can open.
    </Outcome>
  );
}
