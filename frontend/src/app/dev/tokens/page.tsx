import type { Metadata } from "next";

import { ThemeToggle } from "@/components/console/theme-toggle";
import { ContrastAudit } from "./_components/contrast-audit";
import { IconGrid } from "./_components/icon-grid";
import { RoleSwatches } from "./_components/role-swatches";
import { Label, Mono, Section } from "./_components/section";
import { StatusMarks } from "./_components/status-marks";
import {
  Geometry,
  Radii,
  Shadows,
  TypeScale,
} from "./_components/type-and-shape";
import { ROLE_GROUPS } from "./_lib/rows";

export const metadata: Metadata = {
  title: "Tokens",
  description:
    "Every colour role, type step, measurement and status word the console is allowed to use.",
};

export default function TokensPage() {
  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-disp text-tx">Tokens</h1>
            <p className="max-w-prose text-lead text-tx-2">
              Every colour role, type step, measurement and status word the
              console is allowed to use. The contrast figures below are measured
              in this browser, from the pixels on this page — switch the theme
              and the whole audit runs again.
            </p>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3">
          <Label>Source</Label>
          <Mono>frontend/docs/e-console.html:35-167</Mono>
          <span className="text-tx-4" aria-hidden="true">
            ·
          </span>
          <Label>Defined in</Label>
          <Mono>src/app/globals.css</Mono>
        </div>
      </header>

      <Section
        title="Contrast"
        blurb="The contract makes four claims: --tx, --tx-2 and --tx-3 all clear 4.5:1 on a panel, and white clears 4.5:1 on the brand — in both themes. A claim nobody measures is a claim that quietly stops being true, so this measures it."
      >
        <ContrastAudit />
      </Section>

      {ROLE_GROUPS.map((group) => (
        <Section key={group.title} title={group.title} blurb={group.blurb}>
          <RoleSwatches group={group} />
        </Section>
      ))}

      <Section
        title="Type"
        blurb="Seven steps, each carrying its own leading, tracking and weight, so a heading is one decision rather than four. text-ui is the workhorse: rail items and table cells. text-body is body copy and every control."
      >
        <TypeScale />
      </Section>

      <Section
        title="Geometry"
        blurb="Measured off the reference. These are the numbers the shell is built from — the masthead, the scope rail at both widths, the right rail, and the three heights every row in the product snaps to."
      >
        <Geometry />
      </Section>

      <Section
        title="Radii"
        blurb="Three steps and a pill. Controls are rounded-lg, cards and dialogs are rounded-xl, chips and rail items are rounded-md — which is what base-nova's own components already ask for."
      >
        <Radii />
      </Section>

      <Section
        title="Elevation"
        blurb="Three depths, no more. A control rests on the page, a selected thing floats a hair above its neighbours, and a menu pops over everything."
      >
        <Shadows />
      </Section>

      <Section
        title="Status vocabulary"
        blurb="Only what the real enums hold. Docker's and Swarm's states keep their own names in their own maps, because a container state and a deployment status are different vocabularies. Every mark carries its word."
      >
        <StatusMarks />
      </Section>

      <Section
        title="Icons"
        blurb="One map, keyed by the prototype's names, so no other file imports lucide and swapping an icon happens in one place."
      >
        <IconGrid />
      </Section>
    </div>
  );
}
