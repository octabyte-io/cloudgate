import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import type { SamplingState } from "@/lib/format/sampling";

import {
  MonitoringSetupModal,
  type SetupTarget,
} from "../setup/monitoring-setup-modal";

/**
 * The platform host as a `SetupTarget` — the same dialog every Server uses, given
 * the one thing that is different about this machine: Cloudgate reaches it through
 * its own shell rather than over SSH, so a refusal here is about a role and never
 * about reachability.
 */
export function HostSetupModal({
  config,
  state,
  unmeasured,
  openings,
  open,
  onOpenChange,
  save,
}: {
  config: MetricsConfig;
  state: SamplingState;
  /** The live frame reported every total at zero — see `units.ts`. */
  unmeasured: boolean;
  /** Bumped on every open, so the dialog remounts rather than keeping a draft. */
  openings: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: SetupTarget["save"];
}) {
  return (
    /* Keyed by opening — F09's defect: a dialog that stays mounted across a
       close keeps what was typed, so a half-edited retention window would
       come back next time. */
    <MonitoringSetupModal
      key={openings}
      target={{
        name: "this host",
        state,
        config,
        reach: "through the shell Cloudgate runs in",
        description:
          "Cloudgate reads this machine's own /proc through its local shell — no SSH and no agent. Saving registers the collection jobs; the first sample lands one interval later. Setting this up is owner-or-admin, so a refusal here is about your role rather than about the host.",
        caveat: unmeasured ? (
          <>
            This host has already reported a sample in which every total is zero,
            so it has no <code className="font-mono">/proc</code> to read. Sampling
            will register and{" "}
            <strong className="font-medium text-tx">store nothing at all</strong>,
            because an unmeasured sample is dropped rather than saved as an idle
            machine. The thresholds below will therefore never fire either. Worth
            setting up anyway only if this instance is about to move to a Linux
            host.
          </>
        ) : undefined,
        save,
      }}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}
