"use client";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { useArrival } from "@/components/console/use-arrival";
import { settingsHref } from "@/lib/settings/sections";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import {
  DowngradeWaitingStrip,
  KeptStoppedStrip,
  useKeptStopped,
} from "../business-plan";
import { LicenseGate, type KeptReading } from "../license-gate";
import type { ForwardAuthTarget } from "@/lib/api/endpoints/forward-auth";

import { TargetCard } from "./target-card";
import {
  useForwardAuthProviders,
  useForwardAuthTargets,
} from "./use-forward-auth";

/**
 * Forward auth: an oauth2-proxy in front of a deployed Application's domain, so
 * Traefik makes a request prove who it is before the Application sees it.
 *
 * ## Why there is no list of gated domains on this screen
 *
 * The brief asks for per-domain enable/disable "joined against the domains F09
 * manages", and **the join cannot be made here**: nothing lists the domains in
 * an Organization. `domains.controller.ts` serves
 * `GET /applications/:applicationId/domains` and nothing wider.
 *
 * Enumerating the services is no longer the wall it was — they
 * are on `GET /environments/:id` — so what is left is a **fan-out**: every
 * Project, then every Environment, then one domains request per service, on
 * every open of a settings screen. That is a decision to take deliberately
 * rather than a route to wait for. An Environment's Domains tab used to hold
 * the same decision and no longer does: it is answered there with `GET
 * /environments/:id/domains`, a scoped read rather than a fan-out. The
 * equivalent here would be an Organization-scoped domains read, and there is
 * none — so this screen's half of the problem is still the open one.
 *
 * A list that could not show rows is exactly what F08 and F10 refused to build.
 * So the switch is where the domain already is: `DomainGateSwitch` in this
 * folder renders on **F09's domains table**, one row at a time, keyed by the
 * `domainId` that row already has. This screen owns the half that can be
 * enumerated — the Traefik instances — and says where the other half lives.
 *
 * ## What `GET /forward-auth/servers` is listing
 *
 * Not the fleet: one entry per Traefik instance this Organization could gate.
 * The local one is always first and is a real target (`serverId: null`), and the
 * rest are `deploy` servers with an SSH key. A Server with no key cannot be
 * reached to start a container on, so it is not offered — that filter is the
 * backend's and it is the right one.
 *
 * ## Kept but stopped
 *
 * Below the paid features forward auth refuses setting a domain, deploying and
 * gating, and never touches what is already protected. So a target
 * with a domain or a proxy is shown read-only under one strip: a running proxy
 * says "Still protected", setting up is off with why, and removing stays on.
 * With nothing set up anywhere, the lock (`useForwardAuthKept`). While a
 * downgrade waits, `DowngradeWaitingStrip` says when.
 */
export function ForwardAuthSection() {
  return (
    <LicenseGate
      feature="forwardAuth"
      title="Forward auth"
      content={<ForwardAuthContent />}
      useKept={useForwardAuthKept}
    >
      Forward auth puts an authentication proxy in front of an
      Application&rsquo;s own domain: Traefik sends every request to the proxy
      first, and only the ones carrying a valid session from your identity
      provider reach the Application. It is how an internal tool gets a sign-in
      screen without anybody adding one to it.
    </LicenseGate>
  );
}

/** Whether any target has a domain set or a proxy deployed, to keep. */
function useForwardAuthKept(): KeptReading {
  const targets = useForwardAuthTargets();
  return {
    isPending: targets.isPending,
    error: targets.error,
    kept: (targets.data ?? []).some(isSetUp),
  };
}

/** A target forward auth was set up on: a domain, or a proxy deployed. */
export function isSetUp(target: ForwardAuthTarget): boolean {
  return (
    target.authDomain !== null ||
    target.status === "running" ||
    target.status === "failing"
  );
}

function ForwardAuthContent() {
  const targets = useForwardAuthTargets();
  const providers = useForwardAuthProviders();
  const stopped = useKeptStopped("forwardAuth");

  const arrival = useArrival(targets.isPending || providers.isPending);
  if (targets.isPending || providers.isPending) {
    return <SectionPending title="Where a proxy can run" rows={4} />;
  }

  if (targets.error) {
    return (
      <SectionFailed title="Where a proxy can run" error={targets.error}>
        Managing forward auth needs an owner or admin role in this Organization
        on top of the license.
      </SectionFailed>
    );
  }

  const rows = targets.data ?? [];
  const oidcProviders = providers.data ?? [];

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      {stopped ? (
        <KeptStoppedStrip
          feature="forwardAuth"
          what="You can't add or change forward auth."
        />
      ) : (
        <DowngradeWaitingStrip stops="Adding and changing forward auth stops" />
      )}

      {oidcProviders.length === 0 ? (
        <Card>
          <Card.Header title="No identity provider yet" headingLevel={2} />
          <Card.Body>
            <p className="text-body text-tx-2">
              Add an OIDC provider under Single sign-on before deploying a
              proxy. SAML providers are not offered: oauth2-proxy does not speak
              it.
            </p>
            <div className="mt-3">
              <LinkButton href={settingsHref("sso")} size="sm">
                Go to Single sign-on
              </LinkButton>
            </div>
          </Card.Body>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <Card.Body>
            <EmptyState icon="shield" title="Nowhere to deploy a proxy">
              Check the instance settings: a proxy runs on a Traefik instance,
              and this Organization cannot reach one, not even the local one.
            </EmptyState>
          </Card.Body>
        </Card>
      ) : (
        rows.map((target) => (
          <TargetCard
            key={target.serverId ?? "local"}
            target={target}
            providers={oidcProviders}
            stopped={stopped}
          />
        ))
      )}

      <Card>
        <Card.Header title="Putting a domain behind a proxy" headingLevel={2} />
        <Card.Body className="grid gap-2">
          <p className="text-body text-tx-2">
            Once a proxy is running on the Traefik a service uses, each of that
            service&rsquo;s domains gets its own switch — on the{" "}
            <strong className="font-medium text-tx">Domains</strong> tab of the
            Application, beside the host it applies to.
          </p>
          {/* The switch is not repeated here: a domain belongs to a service
              rather than to the Organization, and gathering every gated host
              would mean asking each Application in each Environment in turn. */}
          <p className="text-meta text-tx-2">
            Compose stacks cannot be gated at all: their routers travel as
            deploy-time labels, which carry no middleware, and the backend
            refuses those domains outright.
          </p>
        </Card.Body>
      </Card>
    </div>
  );
}
