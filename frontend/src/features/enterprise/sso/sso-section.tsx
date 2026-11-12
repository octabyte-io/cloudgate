"use client";

import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import {
  DowngradeWaitingStrip,
  KeptStoppedStrip,
  useKeptStopped,
} from "../business-plan";
import { LicenseGate, type KeptReading } from "../license-gate";
import { EnforceCard } from "./enforce-card";
import { ProvidersCard } from "./providers-card";
import { ScimCard } from "./scim-card";
import { ProvenDomainsCard } from "./proven-domains-card";
import { TrustedOriginsCard } from "./trusted-origins-card";
import { useScimProviders, useSsoProviders } from "./use-sso";

/**
 * Single sign-on: the providers, the switch that makes them mandatory, the
 * origins an issuer may move to, and the directory that provisions members.
 *
 * **SCIM is on this screen rather than its own**, and the reason is what a
 * person is doing when they are here: both halves are "how people get into this
 * Organization without somebody typing their address into an invitation".
 * Splitting them would have made a settings strip of nineteen sections where one
 * of them holds two cards.
 *
 * `LicenseGate` wraps the licensed half, and the enforce switch is deliberately
 * **outside** it — `PATCH /sso/enforce` delegates to
 * `SettingsService.updateEnforceSso`, which is owner-or-admin with no licence
 * check, so gating it would invent a refusal. It is inside the gate's *content*
 * anyway, because a switch that turns off password sign-in on an instance whose
 * SSO button does not render (`show-sign-in` reads `hasAnyValidLicense`) is a
 * door with no handles, and that is a worse screen than one that does not offer
 * it. The card says both things where the switch is.
 *
 * ## Kept but stopped
 *
 * Below the paid features the providers and SCIM connections stay, and their
 * reads stay open, so an Organization that set either up sees them read-only
 * under one strip, with Edit and Add off and Remove on; one that set up
 * neither sees the lock (`useSsoKept`). While a downgrade waits, on
 * Business, `DowngradeWaitingStrip` says when SSO sign-in stops.
 */
export function SsoSection() {
  return (
    <LicenseGate
      feature={["sso", "scim"]}
      title="Single sign-on"
      content={<SsoContent />}
      useKept={useSsoKept}
    >
      Single sign-on lets your members sign in with the account they already
      have — an OIDC provider such as Okta, Entra ID, Auth0 or Keycloak —
      instead of a password held here. SCIM goes with it: your directory creates
      and deactivates members for you, so a leaver loses access when HR says so
      rather than when somebody remembers.
    </LicenseGate>
  );
}

/** Whether a provider or a SCIM connection is kept to show read-only. */
function useSsoKept(): KeptReading {
  const providers = useSsoProviders();
  const scim = useScimProviders();
  return {
    isPending: providers.isPending || scim.isPending,
    error: providers.error ?? scim.error,
    kept: (providers.data?.length ?? 0) > 0 || (scim.data?.length ?? 0) > 0,
  };
}

/**
 * What stops when a waiting downgrade arrives, from what is set up;
 * both, before either is.
 */
export function ssoWaitingStops(providers: number, scim: number): string {
  if (providers > 0 && scim === 0) return "SSO sign-in stops";
  if (providers === 0 && scim > 0) return "SCIM stops adding people";
  return "SSO sign-in and SCIM adds stop";
}

/** What the strip says is off, from what was set up. */
export function ssoStoppedWhat(providers: number, scim: number): string {
  if (providers > 0 && scim > 0) {
    return "SSO sign-in is off, and SCIM can't add people.";
  }
  if (providers > 0) return "SSO sign-in is off.";
  return "SCIM can't add people right now.";
}

function SsoContent() {
  const providers = useSsoProviders();
  const scim = useScimProviders();
  const stopped = useKeptStopped(["sso", "scim"]);
  // Proven domains exist only on the Hosted instance (ADR-0051).
  const hosted = useInstanceMode().data === "hosted";

  const arrival = useArrival(providers.isPending);
  if (providers.isPending) {
    return <SectionPending title="Identity providers" rows={3} />;
  }
  if (providers.error) {
    return (
      <SectionFailed title="Identity providers" error={providers.error}>
        Managing providers needs an owner or admin role in this Organization on
        top of the license.
      </SectionFailed>
    );
  }

  const rows = providers.data ?? [];

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      {stopped ? (
        <KeptStoppedStrip
          feature={["sso", "scim"]}
          what={ssoStoppedWhat(rows.length, scim.data?.length ?? 0)}
        />
      ) : (
        <DowngradeWaitingStrip
          stops={ssoWaitingStops(rows.length, scim.data?.length ?? 0)}
        />
      )}
      <ProvidersCard providers={rows} stopped={stopped} />
      {hosted ? <ProvenDomainsCard stopped={stopped} /> : null}
      <EnforceCard providers={rows} />
      <TrustedOriginsCard stopped={stopped} />
      <ScimCard stopped={stopped} />
    </div>
  );
}
