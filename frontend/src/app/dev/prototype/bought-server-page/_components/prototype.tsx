"use client";

import { useSearchParams } from "next/navigation";

import { PageHeader } from "@/components/console/page-header";
import { Tabs } from "@/components/console/tabs";
import { ThemeToggle } from "@/components/console/theme-toggle";

import { VariantA, VariantB, VariantC } from "./variants";

const VARIANTS = [
  {
    id: "a",
    label: "A · Tab on each Server",
    note: "A Bought Server tab in the Server's own rail, shown only on Servers bought from Cloudgate.",
    render: () => <VariantA />,
  },
  {
    id: "b",
    label: "B · Bought Servers page",
    note: "A Bought Servers row in the Organization rail: every bought Server in one table, Manage opens A's page.",
    render: () => <VariantB />,
  },
  {
    id: "c",
    label: "C · Backups and Plan tabs",
    note: "Two tabs on the Server: Backups on its own, and Plan for size, storage, price and Delete.",
    render: (view: string | null) => (
      <VariantC view={view === "plan" ? "plan" : "backups"} />
    ),
  },
] as const;

/**
 * Three places for a Bought Server's backups and changes, as tabs.
 * `?show=a` renders one variant alone (for a screenshot); `&view=plan`
 * opens C's second tab.
 */
export function BoughtServerPagePrototype() {
  const params = useSearchParams();
  const show = VARIANTS.find((v) => v.id === params.get("show"));
  if (show) return show.render(params.get("view"));

  return (
    <div className="flex flex-col gap-6 py-8">
      <div className="mx-auto flex w-full max-w-col flex-wrap items-start justify-between gap-4 px-4 sm:px-6">
        <PageHeader
          className="mb-0"
          title="Bought Server page"
          lede="Three places to put a Bought Server's backups, size, storage and price."
        />
        <ThemeToggle className="mt-1" />
      </div>
      <Tabs defaultValue="a">
        <div className="mx-auto w-full max-w-col px-4 sm:px-6">
          <Tabs.Bar>
            {VARIANTS.map((v) => (
              <Tabs.Tab key={v.id} value={v.id}>
                {v.label}
              </Tabs.Tab>
            ))}
          </Tabs.Bar>
        </div>
        {VARIANTS.map((v) => (
          <Tabs.Panel key={v.id} value={v.id} className="flex flex-col gap-4">
            <p className="mx-auto w-full max-w-col px-4 text-body text-tx-2 sm:px-6">
              {v.note}
            </p>
            <div className="border-y border-line">{v.render(null)}</div>
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
