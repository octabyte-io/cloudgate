import { CURRENT, LABEL, ROW } from "@/components/shell/rail-row";
import { Icon, type IconName } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { ORGANIZATION } from "./fixtures";

/** One rail row of the stand-in shell. `isNew` marks the row a variant adds. */
export type RailEntry =
  | {
      kind: "item";
      label: string;
      icon: IconName;
      current?: boolean;
      isNew?: boolean;
    }
  | { kind: "label"; label: string }
  | { kind: "rule" }
  | { kind: "back"; label: string };

/** The Organization rail as `nav.ts` has it, with `extra` after Servers. */
export function organizationRail(
  current: string,
  extra: RailEntry[] = [],
): RailEntry[] {
  const item = (label: string, icon: IconName): RailEntry => ({
    kind: "item",
    label,
    icon,
    current: label === current,
  });
  return [
    item("Organization home", "home"),
    item("Recents", "clock"),
    item("Starred", "star"),
    item("Servers", "hdd"),
    ...extra.map((entry) =>
      entry.kind === "item"
        ? { ...entry, current: entry.label === current }
        : entry,
    ),
    { kind: "label", label: "Build" },
    item("Projects", "folder"),
    item("Templates", "book"),
    { kind: "label", label: "Observe" },
    item("Deployments", "rocket"),
    item("Monitoring", "activity"),
    item("Requests", "globe"),
    { kind: "rule" },
    item("Settings", "cog"),
    item("Help & support", "buoy"),
  ];
}

/** A Server's rail as `tabs/server.ts` has it, with `extra` before the Settings rule. */
export function serverRail(
  current: string,
  extra: RailEntry[] = [],
): RailEntry[] {
  const item = (label: string, icon: IconName): RailEntry => ({
    kind: "item",
    label,
    icon,
    current: label === current,
  });
  return [
    { kind: "back", label: "Back to Servers" },
    item("Overview", "gauge"),
    item("Infrastructure", "layers"),
    item("Telemetry", "activity"),
    item("Docker & Swarm", "box"),
    item("Access", "key"),
    item("Shell", "term"),
    ...extra.map((entry) =>
      entry.kind === "item"
        ? { ...entry, current: entry.label === current }
        : entry,
    ),
    { kind: "rule" },
    item("Settings", "cog"),
  ];
}

function Row({ entry }: { entry: RailEntry }) {
  if (entry.kind === "rule") {
    return (
      <div aria-hidden="true" className="-mx-3 mt-0.5 mb-2.5 h-px bg-line" />
    );
  }
  if (entry.kind === "label") {
    return (
      <div className="px-2.5 pt-3.5 pb-1.5 text-ui font-medium text-tx-3">
        {entry.label}
      </div>
    );
  }
  if (entry.kind === "back") {
    return (
      <div className="mt-0.5 mb-2.5 flex h-nav w-full items-center gap-2.5 rounded-md bg-raise px-2.5 text-ui font-medium text-tx">
        <Icon name="back" size={15} className="text-tx-3" />
        {entry.label}
      </div>
    );
  }
  return (
    <div
      className={cn(
        ROW,
        "w-full",
        entry.current && CURRENT,
        // The prototype's own marker for the row a variant adds: the brand
        // ring, so a reviewer finds it at a glance. Not part of the design.
        entry.isNew && "inset-ring inset-ring-brand-ring",
      )}
    >
      <Icon
        name={entry.icon}
        size={16}
        className={entry.current ? "text-brand-tx" : "text-tx-3"}
      />
      <span className={cn(LABEL, entry.current && "font-semibold")}>
        {entry.label}
      </span>
      {entry.isNew ? (
        <span className="flex-none rounded-sm border border-brand-line bg-brand-tint px-1.25 py-0.75 text-chip text-brand-tx">
          New
        </span>
      ) : null}
    </div>
  );
}

/**
 * A stand-in for `ConsoleShell`: the masthead, the scope rail and the page.
 * The real shell reads the URL and the session, so the prototype draws the
 * same rows with the same row recipe (`rail-row.tsx`). Below 900px the rail
 * is a drawer in the product, so it is left out here, as it is closed.
 */
export function Frame({
  rail,
  crumb,
  children,
}: {
  rail: RailEntry[];
  crumb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex h-top flex-none items-center gap-3 border-b border-line bg-panel px-4">
        <Icon
          name="lines"
          size={18}
          className="hidden text-tx-2 max-rail:block"
        />
        <span className="grid size-7 place-items-center rounded-md bg-brand text-chip font-semibold text-primary-foreground">
          HL
        </span>
        <span className="text-ui font-semibold text-tx">{ORGANIZATION}</span>
        <span className="text-tx-4">/</span>
        <span className="truncate text-ui text-tx-2">{crumb}</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Prototype rail"
          className="w-rail flex-none border-r border-line bg-panel px-3 pt-3.5 max-rail:hidden"
        >
          {rail.map((entry, index) => (
            <Row key={`${entry.kind}-${index}`} entry={entry} />
          ))}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
