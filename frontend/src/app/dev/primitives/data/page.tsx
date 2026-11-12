import type { Metadata } from "next";

import { PageHeader } from "@/components/console/page-header";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { Section } from "../_components/shell";
import { ReadoutsGallery } from "./_components/readouts";
import { StreamsGallery } from "./_components/streams";
import { TablesGallery } from "./_components/tables";
import { TelemetryGallery } from "./_components/telemetry";

export const metadata: Metadata = {
  title: "Primitives — data",
  description:
    "Tables, readouts, meters, charts, log wells and diffs, on realistic infrastructure content.",
};

export default function DataPrimitivesPage() {
  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          className="mb-0"
          title="Primitives — data"
          lede="The dense half of the library: the components that make this feel like operating infrastructure rather than administering an app. Everything here is on content the product really holds — 71-character image references, 54 Deployments, 500 lines of build output, a diff with a DATABASE_URL nobody can read in one screen."
          strap="Controls, surfaces, status and flows are at /dev/primitives. Tokens and the contrast audit are at /dev/tokens."
        />
        <ThemeToggle className="mt-1" />
      </div>

      <Section
        title="Tables"
        source="e-console.html:612-652"
        blurb="A table declares its columns and hands over its rows; it never assembles cells by hand. The horizontal scroll belongs to the table — its own container, with overscroll-behavior-x: contain, so running out of table does not start scrolling the page. Head and body cells carry position: relative because a visually-hidden label inside a cell needs a containing block there; without it the label lands in the initial containing block and silently widens the document."
      >
        <TablesGallery />
      </Section>

      <Section
        title="Readouts"
        source="e-console.html:654-714"
        blurb="Figures, facts and bars — the furniture of a right rail. Two rules run through all of them. A tone never carries meaning alone: a warn or alarm Meter says its word, and a SplitBar always ships its legend. And a total is never drawn against a quota nobody supplied — SplitBar's total is the sum of its parts, computed here, because this product has no quotas to draw against."
      >
        <ReadoutsGallery />
      </Section>

      <Section
        title="Telemetry"
        source="e-console.html:716-754"
        blurb="One series, plotted. The tones are state — brand at rest, hot in trouble, mute when nothing reports, dead when the series stopped — and they read --chart-*, which in this codebase is our status palette. Identity is the other job and takes the separate --series-* ramp; see lib/design/chart.ts for why the two must not be shared. Scrubbing works with a pointer and with the arrow keys, and every value is in a table underneath either way."
      >
        <TelemetryGallery />
      </Section>

      <Section
        title="Streams"
        source="e-console.html:756-798"
        blurb="Output, and change. The well takes lines and renders them; it never parses them, because what counts as a warning belongs to the tool writing the log. Follow-tail lets go the moment someone scrolls up to read what just went past, and says so. The tail cursor snaps rather than breathes, and stops under prefers-reduced-motion — the settled state of a run still in progress, not a faster flicker."
      >
        <StreamsGallery />
      </Section>
    </div>
  );
}
