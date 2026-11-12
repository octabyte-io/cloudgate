"use client";

import { useState } from "react";
import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";
import { useWebServerSettings } from "@/lib/api/use-web-server-settings";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../section-states";
import { CloudRunLimitsCard } from "./cloud-run-limits-card";
import { ConcurrentBuildsCard } from "./concurrent-builds-card";
import { AssignDomainCard } from "./console-domain-card";
import { ConsoleRouterCard } from "./console-router-card";
import { RequestedPreviewMaxTtlCard } from "./requested-preview-max-ttl-card";
import { GpuCard } from "./gpu-card";
import { InstanceDangerZone } from "./instance-danger-zone";
import { HealthCard } from "./instance-health-card";
import { IdentityCard } from "./instance-identity-card";
import { RuntimeCard } from "./instance-runtime-card";
import { useInstanceGate, usePlatformMutations } from "./use-platform";

/**
 * This deployment of Cloudgate: what it is, where it is reached, whether its
 * dependencies are up, and the two controls that restart it.
 *
 * The one setting that is a single field and nothing else is inline; everything
 * with its own reasoning is a sibling file, named for the card it draws.
 * Concurrent builds joined them when it grew a licence notice: it is one
 * field, but which sentence it shows depends on a second read.
 */
export function InstanceSection() {
  const settings = useWebServerSettings();
  const mutations = usePlatformMutations();
  // Every write on this screen takes instance authority (ADR-0013), and so
  // does the health read the gate is taken from.
  const gate = useInstanceGate();
  /**
   * Whether anybody has asked Docker Hub yet.
   *
   * It lives here rather than in either card because **both** need it and they
   * need it for opposite reasons: the identity card uses it to decide whether to
   * say "not checked yet", and the danger zone uses it to decide whether
   * "Update and restart" would do anything at all. The query itself is shared —
   * same key, so the second reader is a cache hit — but "has this been asked
   * for" is a fact about the session and not about the answer.
   */
  const [checkedUpdates, setCheckedUpdates] = useState(false);

  const arrival = useArrival(settings.isPending);
  if (settings.isPending) return <SectionPending title="This instance" rows={4} />;
  if (settings.error || !settings.data) {
    return (
      <SectionFailed title="This instance" error={settings.error}>
        Everything on this screen hangs off the one settings row, so nothing else
        here can be shown until that read works.
      </SectionFailed>
    );
  }

  const row = settings.data;

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <IdentityCard
        checked={checkedUpdates}
        onCheck={() => setCheckedUpdates(true)}
      />
      {/*
        Directly under the identity card, because the two are the declared and
        the observed halves of one question and the identity card is the half
        that cannot answer it: `/settings/version` re-serves a constant this
        process was compiled with. On an instance with no `Server` rows this is
        the only screen in the console showing a reading off a real machine
        — every other one lives under a `[serverId]` route.
      */}
      <RuntimeCard />
      <HealthCard />

      <SettingsCard
        gate={gate}
        title="Public address"
        lede="The address operators reach this instance on. Cloudgate does not detect it."
        schema={z.object({
          serverIp: z.string().max(255),
        })}
        fields={[
          {
            kind: "text",
            name: "serverIp",
            label: "Address",
            optional: true,
            mono: true,
            placeholder: "203.0.113.10",
            hint: "An IP or a hostname. It is stored and shown; nothing verifies it.",
          },
        ]}
        defaultValues={{ serverIp: row.serverIp ?? "" }}
        submit={(values) => mutations.updateIp.mutateAsync(values.serverIp)}
        savedMessage="The public address is saved."
      />

      <ConcurrentBuildsCard value={row.buildsConcurrency} />
      <CloudRunLimitsCard
        concurrency={row.cloudRunsConcurrency}
        timeLimitMinutes={row.cloudRunTimeLimitMinutes}
      />
      <RequestedPreviewMaxTtlCard value={row.requestedPreviewMaxTtlMinutes} />

      <AssignDomainCard
        host={row.host}
        https={row.https}
        certificateType={row.certificateType}
        letsEncryptEmail={row.letsEncryptEmail}
      />

      {/* Directly under the form that writes `dynamic/cloudgate.yml`, because
          what Traefik made of that file is the answer to the question the form
          raises — the card itself explains why the report can live inside the
          console it is about. */}
      <ConsoleRouterCard consoleOrigin={row.consoleOrigin} />

      <GpuCard />
      <InstanceDangerZone checked={checkedUpdates} />
    </div>
  );
}
