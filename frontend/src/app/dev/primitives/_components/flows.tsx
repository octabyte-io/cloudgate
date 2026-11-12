"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Skeleton } from "@/components/console/skeleton";
import { Stepper } from "@/components/console/stepper";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { Row } from "./shell";

const STEPS = [
  { id: "source", label: "Source", done: true },
  { id: "build", label: "Build settings", done: true },
  { id: "environment", label: "Environment" },
  { id: "review", label: "Review" },
];

const SOURCES = [
  {
    id: "git",
    title: "A Git repository",
    description: "Build from a branch and redeploy on every push.",
    meta: "github · gitlab · bitbucket",
    icon: "branch" as const,
  },
  {
    id: "image",
    title: "A container image",
    description: "Pull an image that is already built and pushed.",
    meta: "ghcr.io/octabyte/checkout-api",
    icon: "box" as const,
  },
  {
    id: "compose",
    title: "A Compose file",
    description: "Bring several containers up together as one stack.",
    meta: "docker-compose.yml",
    icon: "layers" as const,
  },
  {
    id: "dockerfile",
    title: "A Dockerfile",
    description: "Not wired up in this gallery — shown inert.",
    meta: "Dockerfile",
    icon: "hdd" as const,
    inert: true,
  },
];

export function FlowsGallery() {
  const [step, setStep] = useState("environment");
  const [source, setSource] = useState("git");

  return (
    <>
      <Row label="Stepper" note="numbered, ticked when done, aria-current on the one you are on" className="block">
        <Stepper
          label="Create an Application"
          steps={STEPS}
          currentId={step}
          onSelect={setStep}
        />
      </Row>

      <Row label="PickCard and PickGrid" className="block">
        <PickGrid label="Where this Application comes from">
          {SOURCES.map((option) => (
            <PickCard
              key={option.id}
              title={option.title}
              description={option.description}
              meta={option.meta}
              icon={option.icon}
              selected={source === option.id}
              inert={option.inert}
              onClick={() => setSource(option.id)}
            />
          ))}
        </PickGrid>
      </Row>

      <Row label="EmptyState" className="block">
        <Card tone="plain">
          <Card.Body flush>
            <EmptyState
              icon="rocket"
              title="No Deployments yet"
              action={
                <Button variant="pri">
                  <Icon name="rocket" />
                  Deploy checkout-api
                </Button>
              }
            >
              A Deployment builds this Application and rolls it onto its
              Servers. The first one takes longer, because nothing is cached
              yet.
            </EmptyState>
          </Card.Body>
        </Card>
      </Row>

      <Row label="Skeleton" note="aria-hidden; the region around it carries aria-busy" className="block">
        <Card tone="plain">
          <Card.Body
            aria-busy="true"
            className="flex flex-col gap-3"
          >
            <Skeleton className="w-40" />
            <Skeleton className="w-full" />
            <Skeleton className="w-2/3" />
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-pill" />
              <Skeleton className="w-32" />
            </div>
          </Card.Body>
        </Card>
      </Row>
    </>
  );
}
