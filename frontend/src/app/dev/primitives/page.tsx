import type { Metadata } from "next";

import { PageHeader } from "@/components/console/page-header";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { ControlsGallery } from "./_components/controls";
import { FlowsGallery } from "./_components/flows";
import { FormsGallery } from "./_components/forms";
import { OverlaysGallery } from "./_components/overlays";
import { Section } from "./_components/shell";
import { StatusGallery } from "./_components/status";
import { SurfacesGallery } from "./_components/surfaces";

export const metadata: Metadata = {
  title: "Primitives",
  description:
    "Every control, surface, status mark, flow piece and overlay the console is built from, in every variant and state.",
};

export default function PrimitivesPage() {
  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          className="mb-0"
          title="Primitives"
          lede="Every control, surface, status mark, flow piece and overlay, in every variant and state — including the inert and error ones. After this page no feature screen styles a button, a card, a badge or a form control by hand."
          strap="Recipes are in frontend/docs/e-console.html. Tokens and the contrast audit are at /dev/tokens."
        />
        <ThemeToggle className="mt-1" />
      </div>

      <Section
        title="Controls"
        source="e-console.html:436-511"
        blurb="Buttons in four tones and three heights, the search field, the segmented control and the tab strip. An off control is marked aria-disabled rather than disabled: it keeps its place in the tab order, so a keyboard user can reach it and hear why it is off, and one unlayered rule in globals.css gives every one of them the same inert look."
      >
        <ControlsGallery />
      </Section>

      <Section
        title="Surfaces"
        source="e-console.html:403-432, 513-571"
        blurb="The page header, the section heading, the two-column layout, the card and its parts, the inset meta strip, and the collapsible banner. Banner copy wraps anywhere, because real infrastructure prose contains image digests and resource addresses that no word-break would ever find a seam in."
      >
        <SurfacesGallery />
      </Section>

      <Section
        title="Status"
        source="e-console.html:573-610"
        blurb="None of these takes a colour prop. The key decides the tone, from lib/design/status.ts, so the same state cannot read as green on one screen and amber on the next. Every mark ships its word — visibly in a pill, in an sr-only span beside a bare dot or a gutter glyph."
      >
        <StatusGallery />
      </Section>

      <Section
        title="Flows"
        source="e-console.html:800-848"
        blurb="The pieces a multi-step task is assembled from. An empty state is an invitation to act rather than a report that a query returned zero rows, so it names the thing, says what it is for, and carries the control that creates the first one."
      >
        <FlowsGallery />
      </Section>

      <Section
        title="Overlays"
        source="e-console.html:850-895"
        blurb="A menu, a dialog and the toast host. The menu row is deliberately reusable outside a menu — the reference leaves it unscoped so the same row works as a compact list row on a card, and the two cannot drift apart. F05 mounts the command palette on the same pieces."
      >
        <OverlaysGallery />
      </Section>

      <Section
        title="Forms"
        source="e-console.html:463-470"
        blurb="react-hook-form with a zod resolver, because the backend is zod-first and a form schema should be the same shape of thing the endpoint checks. Field is the only place the console does form plumbing: a 400 with field issues goes back to the fields it is about, and everything else — a 403, a 409, a backend that is not running — goes above the buttons and to a toast."
      >
        <FormsGallery />
      </Section>
    </div>
  );
}
