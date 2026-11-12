"use client";

import { useSearchParams } from "next/navigation";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Outcome } from "@/components/console/outcome";
import { Page } from "@/components/console/page";
import { Skeleton } from "@/components/console/skeleton";
import { Stepper } from "@/components/console/stepper";
import { Button } from "@/components/ui/button";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";

import { useTemplateCatalogue } from "../templates/use-templates";
import { DetailsStep } from "./details-step";
import { LaunchView } from "./launch-view";
import { ServerStep } from "./server-step";
import {
  readWizard,
  stepOf,
  type WizardState,
  type WizardStep,
} from "./wizard-state";

/**
 * **Get started** (`/get-started?template=<id>`): where the public templates
 * website's "Deploy <app>" button lands. Its reader may know nothing about
 * servers or Cloudgate, so it is one calm column of plain sentences, three
 * steps long, ending with the app running and its address.
 *
 * The sign-in gate (`proxy.ts`) already sends a visitor with no session to
 * sign in or sign up and back here with the query intact. Every step lives
 * in the address (`wizard-state.ts`), which is what carries it through
 * Stripe Checkout and a reload.
 *
 * The app's name and logo are the catalogue's own entry, read through the
 * catalogue screen's query (an hour's `staleTime`), so arriving from the
 * Templates screen costs no request.
 */
export function GetStartedScreen() {
  const state = readWizard(useSearchParams());
  const catalogue = useTemplateCatalogue();

  if (!state.templateId) return <UnknownApp />;

  if (catalogue.error) {
    return (
      <Page>
        <div className="mx-auto grid max-w-3xl gap-5">
          <Card>
            <Card.Body className="grid justify-items-start gap-3">
              <p className="text-body text-tx">
                The list of apps could not be read, so this one cannot be set
                up yet.
              </p>
              <p className="text-ui text-tx-2">
                {errorMessage(catalogue.error)}
              </p>
              <Button onClick={() => void catalogue.refetch()}>
                Try again
              </Button>
            </Card.Body>
          </Card>
        </div>
      </Page>
    );
  }

  if (catalogue.isPending) {
    return (
      <Page>
        <div className="mx-auto grid max-w-3xl gap-5" aria-busy="true">
          <Skeleton className="h-12 w-72" />
          <Skeleton className="h-thead" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  const template = catalogue.data.templates.find(
    (entry) => entry.id === state.templateId,
  );
  if (!template) return <UnknownApp />;

  const step = stepOf(state);

  return (
    <Page>
      <div className="mx-auto grid max-w-3xl gap-5">
        <AppHeader template={template} />
        <WizardStepper step={step} appName={template.name} />
        {/*
          The step body is the one thing that moves when the wizard moves on:
          the header and the stepper stay still, and the new step rises into
          the place the last one left. Keyed by the step and the way chosen,
          not by every query parameter — the buy path writes the Server it
          found into the address once it is already showing it, and that must
          not replay the entrance.
        */}
        <div key={stepKey(step, state)} className="grid animate-rise">
          {step === "launch" && state.environmentId ? (
            <LaunchView
              template={template}
              environmentId={state.environmentId}
            />
          ) : step === "details" && state.serverId ? (
            <DetailsStep template={template} serverId={state.serverId} />
          ) : (
            <ServerStep template={template} state={state} />
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * Which body the wizard shows, for the entrance above. On the own path a
 * Server in the address means its connect step, a different screen from the
 * form that saved it; on the buy path it only names the purchase already on
 * screen.
 */
function stepKey(step: WizardStep, state: WizardState): string {
  const connecting = state.path === "own" && state.serverId !== null;
  return `${step}:${state.path ?? "choose"}${connecting ? ":connect" : ""}`;
}

/** The app being deployed, by its catalogue logo and name. */
function AppHeader({ template }: { template: TemplateSummary }) {
  return (
    <header className="flex items-center gap-3.5">
      {/* A `data:` address from the catalogue file, as on the catalogue's
          cards: nothing to optimise or fetch. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={template.logo}
        alt=""
        className="size-12 flex-none rounded-xl border border-line bg-panel object-contain p-2"
      />
      <div className="grid min-w-0 gap-0.5">
        <h1 className="text-disp wrap-anywhere text-tx">
          Deploy {template.name}
        </h1>
        <p className="text-lead text-tx-2">
          A few steps, and {template.name} runs on a server of your own.
        </p>
      </div>
    </header>
  );
}

const STEPS: WizardStep[] = ["server", "details", "launch"];

/** Where the wizard is: a read-out, since each step is reached by finishing the last. */
function WizardStepper({
  step,
  appName,
}: {
  step: WizardStep;
  appName: string;
}) {
  const at = STEPS.indexOf(step);
  const labels: Record<WizardStep, string> = {
    server: "Choose a server",
    details: `Set up ${appName}`,
    launch: `Launch ${appName}`,
  };
  return (
    <Stepper
      label="Steps to deploy"
      currentId={step}
      steps={STEPS.map((id, index) => ({
        id,
        label: labels[id],
        done: index < at,
      }))}
    />
  );
}

/** A link that names no app, or an app the catalogue no longer has. */
function UnknownApp() {
  return (
    <Outcome
      tone="info"
      icon="book"
      title="That app isn't in the catalogue"
      action={
        <LinkButton href="/templates" variant="pri">
          See all apps
        </LinkButton>
      }
    >
      The link may be out of date. Pick the app again from the list of
      templates.
    </Outcome>
  );
}
