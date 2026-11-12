import { useState } from "react";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { GpuInfo, GpuSetupState } from "@/lib/api/endpoints/settings";
import { useGpu, useSetupGpu } from "@/lib/api/use-gpu";
import type { Gate } from "@/lib/auth/use-permission";

import { GpuSetupConfirmModal } from "./gpu-setup-confirm-modal";

/** The three GPU setup states, in words. */
const SETUP_STATE: Record<
  GpuSetupState,
  { pill: string; tone: "ok" | "warn" | "mute"; glyph: string }
> = {
  none: { pill: "Not set up", tone: "mute", glyph: "○" },
  count: {
    pill: "Set up the old way: run setup again",
    tone: "warn",
    glyph: "◐",
  },
  "card-id": { pill: "Set up by card ID", tone: "ok", glyph: "●" },
};

/**
 * Whether a machine can hand a GPU to a container — the platform host on
 * Instance settings, a Server on its Infrastructure tab.
 *
 * **`gate` is the caller's**, since the two machines take different
 * authority: the platform host is ADR-0013's instance authority, a Server is
 * its organization's owners and admins with access to it.
 *
 * **Read as findings rather than as six booleans**, which is F13's
 * Infrastructure tab wearing different clothes and for the same reason: a
 * cross beside `runtimeConfigured` is not something anybody can act on, and
 * "the NVIDIA container runtime is not installed" is.
 *
 * **It is behind a button because it cannot fail.** `checkGpuStatus` catches
 * everything and answers with all six readings false, so a machine with no
 * `nvidia-smi` and one that refused the connection produce the *same*
 * document. Rendering that on arrival would put a card full of crosses on
 * every machine nobody ever intended to run a GPU on. Asking makes it a
 * question somebody chose to ask.
 *
 * **Three setup states, not two.** A machine set up the old way advertises a
 * count (`GPU=<n>`), which cannot reserve a particular card; it reads "set up
 * the old way: run setup again" and does not count as ready. Only a machine
 * set up by card ID does.
 */
export function GpuSupportCard({
  serverId,
  machineName,
  checkLabel,
  gate,
}: {
  /** The machine. `null` is the platform host. */
  serverId: string | null;
  /** "the platform host", or the Server's name — for the confirm dialog. */
  machineName: string;
  /** "Check this host", "Check this Server". */
  checkLabel: string;
  gate: Gate;
}) {
  const [asked, setAsked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const gpu = useGpu(serverId, asked);
  const setupGpu = useSetupGpu(serverId);
  const refusal = gate.allowed ? undefined : gate.refusal;

  const info = gpu.data;
  const state = info ? SETUP_STATE[info.gpuSetup ?? "none"] : undefined;
  const ready =
    info?.driverInstalled &&
    info?.runtimeInstalled &&
    info?.runtimeConfigured &&
    info?.gpuSetup === "card-id";

  async function runSetup() {
    setConfirming(false);
    if (!gate.allowed) return;
    try {
      await setupGpu.mutateAsync();
      toast.done("GPU support is set up. Re-checking.");
      void gpu.refetch();
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card aria-busy={gpu.isFetching || undefined}>
      <Card.Header
        title="GPU support"
        sub="Whether a Deployment on this machine can be given a GPU."
        headingLevel={2}
        actions={
          !asked ? (
            <Button
              size="sm"
              disabled={!gate.allowed}
              title={refusal}
              onClick={() => gate.allowed && setAsked(true)}
            >
              {checkLabel}
            </Button>
          ) : info && state ? (
            <StatusPill
              mark={
                ready
                  ? { glyph: "●", tone: "ok", label: "Ready" }
                  : { glyph: state.glyph, tone: state.tone, label: state.pill }
              }
            />
          ) : null
        }
      />
      <Card.Body className="grid gap-3.5">
        {!asked ? (
          <p className="text-body text-tx-2">
            Cloudgate asks NVIDIA&rsquo;s own tooling over the shell. It has no
            way of knowing whether this machine has a GPU without doing that, so
            it does not ask on its own.
          </p>
        ) : gpu.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : gpu.error ? (
          <p className="text-body wrap-anywhere text-tx-2">
            {errorMessage(gpu.error)}
          </p>
        ) : info ? (
          <>
            <KVList>
              {findings(info).map((finding) => (
                <KVRow
                  key={finding.label}
                  label={finding.label}
                  value={
                    <span className="flex flex-wrap items-center justify-end gap-1.75">
                      {finding.detail ? (
                        <span className="text-meta text-tx-2">
                          {finding.detail}
                        </span>
                      ) : null}
                      <StatusPill
                        mark={
                          finding.ok
                            ? { glyph: "●", tone: "ok", label: "yes" }
                            : { glyph: "○", tone: "mute", label: "no" }
                        }
                      />
                    </span>
                  }
                />
              ))}
            </KVList>

            {!ready ? (
              <div className="rounded-lg border border-line bg-panel-2 p-3.5">
                <p className="text-body font-medium text-tx">
                  {info.gpuSetup === "count"
                    ? "Set up GPU support again"
                    : "Set up GPU support"}
                </p>
                <p className="mt-1 text-meta text-tx-2">
                  {info.gpuSetup === "count"
                    ? "This machine advertises how many GPUs it has, not which ones, so Swarm cannot reserve a particular card. Setup lists each card by its own ID instead. "
                    : ""}
                  Points Docker at the NVIDIA container runtime and lists each
                  GPU to Swarm by its card ID. It needs the NVIDIA driver and
                  the container runtime to already be on this machine — that
                  part is not Cloudgate&rsquo;s to install. It restarts Docker,
                  and asks before it does.
                </p>
                <div className="mt-2.5">
                  <Button
                    size="sm"
                    disabled={!gate.allowed || setupGpu.isPending}
                    title={refusal}
                    aria-busy={setupGpu.isPending || undefined}
                    onClick={() => gate.allowed && setConfirming(true)}
                  >
                    Run GPU setup
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </Card.Body>
      {asked && info ? (
        <Card.Footer>
          These readings all come back false when the check itself cannot run,
          so a machine that answered nothing looks exactly like one with no GPU.
          What this card is not telling you is whether the machine was
          reachable.
        </Card.Footer>
      ) : null}
      <GpuSetupConfirmModal
        machineName={machineName}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void runSetup()}
      />
    </Card>
  );
}

/** The six probes, as sentences somebody can act on. */
function findings(info: GpuInfo) {
  const setup = info.gpuSetup ?? "none";
  return [
    {
      label: "NVIDIA driver",
      ok: info.driverInstalled,
      detail: info.driverVersion,
    },
    {
      label: "GPU",
      ok: info.availableGPUs > 0,
      detail:
        info.gpuModel ??
        (info.availableGPUs > 0 ? `${info.availableGPUs}` : undefined),
    },
    {
      label: "Container runtime installed",
      ok: info.runtimeInstalled,
    },
    {
      label: "Docker configured to use it",
      ok: info.runtimeConfigured,
    },
    {
      label: "CUDA",
      ok: info.cudaSupport,
      detail: info.cudaVersion,
    },
    {
      label: "Advertised to Swarm",
      // Only by card ID counts: a count cannot reserve a card.
      ok: setup === "card-id",
      // How many and which way, never why not. This row used to caption
      // a cross with "this host is not in a Swarm", derived from
      // `swarmEnabled` — which the backend sets only when `docker node inspect
      // self` lists a GPU generic resource, so it is false on every Swarm host
      // that has no GPU. Nothing here reads Swarm membership, so nothing here
      // says anything about it.
      detail:
        setup === "card-id"
          ? `${info.gpuResources} by card ID`
          : setup === "count"
            ? `${info.gpuResources}, set up the old way: run setup again`
            : undefined,
    },
  ];
}
