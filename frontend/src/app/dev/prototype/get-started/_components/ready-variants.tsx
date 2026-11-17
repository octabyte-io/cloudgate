"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { SegmentedProgress } from "@/components/console/segmented-progress";
import { Stepper } from "@/components/console/stepper";
import { Tabs } from "@/components/console/tabs";
import { Button } from "@/components/ui/button";
import { StageList } from "@/features/get-started/wizard-parts";

import { DetailsCard } from "./details-variants";
import { BOUGHT } from "./fixtures";

/** The Bought Server's stages, as the wizard reads them at Setting up. */
const STAGES = [
  { id: "pay", label: "Payment", state: "done" as const },
  { id: "make", label: "Creating your server", state: "done" as const },
  { id: "setup", label: "Setting it up", state: "now" as const },
  { id: "ready", label: "Ready to use", state: "todo" as const },
];

/**
 * A: Buy goes straight on to step two. The server's progress is a strip
 * above the details: something happening on its own, not a step to take.
 */
export function ReadyVariantA() {
  return (
    <div className="grid gap-4.5">
      <Card>
        <Card.Body className="grid gap-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-body font-medium wrap-anywhere text-tx">
              {BOUGHT.name}: setting it up
            </p>
            <p className="text-meta text-tx-3">Step 3 of 4 · usually a few minutes</p>
          </div>
          <SegmentedProgress label="Your server" steps={STAGES} />
          <p className="text-meta text-tx-2">
            flatnotes starts on its own once the server is ready. You can leave
            this page.
          </p>
        </Card.Body>
      </Card>
      <DetailsCard folded />
    </div>
  );
}

/**
 * B: the progress card stays where Buy left it. The way to step two is a
 * quiet button under a sentence that says it can wait.
 */
export function ReadyVariantB() {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-4.5">
      <ReadyCardB open={open} setOpen={setOpen} />
      {open ? <DetailsCard folded /> : null}
    </div>
  );
}

function ReadyCardB({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Card>
      <Card.Header
        title={`Getting ${BOUGHT.name} ready`}
        sub="This usually takes a few minutes. You can leave this page; it carries on."
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        <StageList label="Your server" stages={STAGES} />
        {open ? null : (
          <div className="grid justify-items-start gap-2 border-t border-line pt-4">
            <p className="text-ui text-tx-2">
              Nothing to do while you wait. If you like, fill in flatnotes&rsquo;
              details now and it starts as soon as the server is ready;
              otherwise we&rsquo;ll ask once it is.
            </p>
            <Button type="button" variant="qt" onClick={() => setOpen(true)}>
              Fill in flatnotes&rsquo; details while you wait
            </Button>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}

const VARIANTS = [
  {
    id: "a",
    label: "A · Straight to the details, progress strip",
    step: "details" as const,
    node: <ReadyVariantA />,
  },
  {
    id: "b",
    label: "B · Progress card, details optional",
    step: "server" as const,
    node: <ReadyVariantB />,
  },
];

/**
 * Section 2 of the prototype: what follows Buy while the server is made and
 * set up, each variant under the wizard's own step bar so the step it puts
 * the person on is visible.
 */
export function ReadyVariants() {
  return (
    <Tabs defaultValue="a">
      <Tabs.Bar>
        {VARIANTS.map((variant) => (
          <Tabs.Tab key={variant.id} value={variant.id}>
            {variant.label}
          </Tabs.Tab>
        ))}
      </Tabs.Bar>
      {VARIANTS.map((variant) => (
        <Tabs.Panel key={variant.id} value={variant.id} className="pt-6">
          <div className="mx-auto grid max-w-3xl gap-5">
            <Stepper
              label="Steps to deploy"
              currentId={variant.step}
              steps={[
                {
                  id: "server",
                  label: "Choose a server",
                  done: variant.step === "details",
                },
                { id: "details", label: "Set up flatnotes", done: false },
                { id: "launch", label: "Launch flatnotes", done: false },
              ]}
            />
            {variant.node}
          </div>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
