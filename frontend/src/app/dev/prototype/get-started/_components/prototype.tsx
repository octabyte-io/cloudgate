"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { Stepper } from "@/components/console/stepper";
import { Tabs } from "@/components/console/tabs";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { keys } from "@/lib/api/keys";
import { cn } from "@/lib/utils";

import { BuyVariantA, BuyVariantB, BuyVariantC } from "./buy-variants";
import { DetailsVariants } from "./details-variants";
import { CATALOGUE } from "./fixtures";
import { ReadyVariants } from "./ready-variants";

/** The page's own client: seeded, and never refetching, so nothing reaches a backend. */
function prototypeClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(keys.boughtServers.catalogue(null), CATALOGUE);
  return client;
}

type Variant = { id: string; label: string; step: "server" | "details"; node: React.ReactNode; wide?: boolean };

const SECTIONS: Array<{ id: string; title: string; question: string; variants: Variant[] }> = [
  {
    id: "buy",
    title: "1 · Choose a server: buy from Cloudgate",
    question:
      "Every buy option in the wizard: Closest and Cheapest, place, Server family and size, operating system, backups, extra storage.",
    variants: [
      { id: "a", label: "A · Two columns, sticky summary", step: "server", node: <BuyVariantA />, wide: true },
      { id: "b", label: "B · One line per choice", step: "server", node: <BuyVariantB /> },
      { id: "c", label: "C · Suggestions first, Customise", step: "server", node: <BuyVariantC /> },
    ],
  },
];

function WizardFrame({ variant }: { variant: Variant }) {
  const at = variant.step === "server" ? 0 : 1;
  return (
    <div className={cn("mx-auto grid w-full gap-5", variant.wide ? "max-w-6xl" : "max-w-3xl")}>
      <header className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="grid size-12 flex-none place-items-center rounded-xl border border-line bg-panel text-disp text-tx-2"
        >
          f
        </span>
        <div className="grid min-w-0 gap-0.5">
          <h2 className="text-disp text-tx">Deploy flatnotes</h2>
          <p className="text-lead text-tx-2">
            A few steps, and flatnotes runs on a server of your own.
          </p>
        </div>
      </header>
      <Stepper
        label="Steps to deploy"
        currentId={variant.step}
        steps={[
          { id: "server", label: "Choose a server", done: at > 0 },
          { id: "details", label: "Set up flatnotes", done: false },
          { id: "launch", label: "Launch flatnotes", done: false },
        ]}
      />
      {variant.node}
    </div>
  );
}

/**
 * The get-started redesign's open layouts, side by side as tabs. `?show=buy-b`
 * renders that one variant alone, for a screenshot or an iframe.
 */
export function GetStartedPrototype() {
  const [client] = useState(prototypeClient);
  const show = useSearchParams().get("show");
  // `?show=section-ready` / `?show=section-details` render that whole
  // section alone (its own tabs), for an iframe at phone width.

  const only = show
    ? SECTIONS.flatMap((section) =>
        section.variants
          .filter((variant) => `${section.id}-${variant.id}` === show)
          .map((variant) => variant),
      )[0]
    : undefined;

  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto flex w-full max-w-col flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        {show === "section-ready" ? (
          <ReadyVariants />
        ) : show === "section-details" ? (
          <DetailsVariants />
        ) : only ? (
          <WizardFrame variant={only} />
        ) : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="grid gap-2">
                <h1 className="text-disp text-tx">Get started: prototype</h1>
                <p className="max-w-lede text-lead text-tx-2">
                  The open layouts of the get-started redesign, on fixture data.
                  Nothing here reaches a backend.
                </p>
              </div>
              <ThemeToggle />
            </header>
            {SECTIONS.map((section) => (
              <section key={section.id} aria-labelledby={`s-${section.id}`} className="grid gap-3">
                <div className="grid gap-1">
                  <h2 id={`s-${section.id}`} className="text-sect text-tx">
                    {section.title}
                  </h2>
                  <p className="text-ui text-tx-2">{section.question}</p>
                </div>
                <Tabs defaultValue={section.variants[0].id}>
                  <Tabs.Bar>
                    {section.variants.map((variant) => (
                      <Tabs.Tab key={variant.id} value={variant.id}>
                        {variant.label}
                      </Tabs.Tab>
                    ))}
                  </Tabs.Bar>
                  {section.variants.map((variant) => (
                    <Tabs.Panel key={variant.id} value={variant.id} className="pt-6">
                      <WizardFrame variant={variant} />
                    </Tabs.Panel>
                  ))}
                </Tabs>
              </section>
            ))}
            <section aria-labelledby="s-ready" className="grid gap-3">
              <div className="grid gap-1">
                <h2 id="s-ready" className="text-sect text-tx">
                  2 · After Buy: the server gets ready
                </h2>
                <p className="text-ui text-tx-2">
                  Filling in flatnotes&rsquo; details is the next step, but it
                  need not wait for the server.
                </p>
              </div>
              <ReadyVariants />
            </section>
            <section aria-labelledby="s-details" className="grid gap-3">
              <div className="grid gap-1">
                <h2 id="s-details" className="text-sect text-tx">
                  3 · Set up flatnotes
                </h2>
                <p className="text-ui text-tx-2">
                  The Template setup&rsquo;s fields: asked values, Domain with
                  Check DNS, Project and setup name.
                </p>
              </div>
              <DetailsVariants />
            </section>
          </>
        )}
      </div>
    </QueryClientProvider>
  );
}
