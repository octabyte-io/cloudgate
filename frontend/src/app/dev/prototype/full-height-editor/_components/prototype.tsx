"use client";

import { useSearchParams } from "next/navigation";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { PageHeader } from "@/components/console/page-header";
import { Tabs } from "@/components/console/tabs";
import { ThemeToggle } from "@/components/console/theme-toggle";

import { FileCard, type Variant } from "./file-card";
import { SERVICES, STACK_NAME } from "./fixtures";

const VARIANTS: Array<{ id: Variant; label: string; note: string }> = [
  {
    id: "a",
    label: "A · Dialog",
    note: "Expand opens the file in a dialog the height of the screen, over the blurred page.",
  },
  {
    id: "b",
    label: "B · Full screen",
    note: "Full screen hands the whole viewport to the file, with Save in a bar on top. Esc comes back.",
  },
  {
    id: "c",
    label: "C · Grow in place",
    note: "Full height makes the card's own editor fill the screen; no overlay, Save sticks to the bottom.",
  },
];

/** The Overview tab of a compose stack, around the one card that changes. */
function StackPage({ variant, open }: { variant: Variant; open: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        className="mb-0"
        title={STACK_NAME}
        badges={<Chip variant="brand">Production</Chip>}
        lede="The invoicing API, its worker and their stores."
      />
      <Tabs defaultValue="overview">
        <Tabs.Bar>
          {["Overview", "Deployments", "Variables", "Domains", "Logs", "Advanced"].map(
            (name) => (
              <Tabs.Tab key={name} value={name.toLowerCase()}>
                {name}
              </Tabs.Tab>
            ),
          )}
        </Tabs.Bar>
        <Tabs.Panel value="overview" className="flex flex-col gap-4">
          <FileCard key={variant} variant={variant} startOpen={open} />
          <Card>
            <Card.Header title="Declared services" sub="Parsed from the file as it was last saved." />
            <Card.Body flush>
              <ul className="divide-y divide-line">
                {SERVICES.map((service) => (
                  <li key={service.name} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-body font-medium text-tx">{service.name}</span>
                    <Chip variant="mono" className="ml-auto">
                      {service.image}
                    </Chip>
                  </li>
                ))}
              </ul>
            </Card.Body>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

/**
 * Three ways to give a file editor the screen's height, as tabs.
 * `?show=a` renders one variant alone (for a screenshot) and `&open=1` opens it.
 */
export function FullHeightEditorPrototype() {
  const params = useSearchParams();
  const show = params.get("show") as Variant | null;
  const open = params.get("open") === "1";

  if (show && VARIANTS.some((v) => v.id === show)) {
    return (
      <div className="mx-auto w-full max-w-col px-4 py-6 sm:px-6 sm:py-8">
        <StackPage variant={show} open={open} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          className="mb-0"
          title="Full-height editor"
          lede="Three ways to give a file editor the height of the screen. Press the button on the Compose file card."
        />
        <ThemeToggle className="mt-1" />
      </div>
      <Tabs defaultValue="a">
        <Tabs.Bar>
          {VARIANTS.map((v) => (
            <Tabs.Tab key={v.id} value={v.id}>
              {v.label}
            </Tabs.Tab>
          ))}
        </Tabs.Bar>
        {VARIANTS.map((v) => (
          <Tabs.Panel key={v.id} value={v.id} className="flex flex-col gap-4">
            <p className="text-body text-tx-2">{v.note}</p>
            <StackPage variant={v.id} open={false} />
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
