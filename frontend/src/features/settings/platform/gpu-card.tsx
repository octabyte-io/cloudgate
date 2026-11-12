import { GpuSupportCard } from "@/components/console/gpu-support-card";

import { useInstanceGate } from "./use-platform";

/**
 * The platform host's GPU support card. Both `GET /settings/gpu` and the setup
 * take instance authority for the platform host (ADR-0013), so both buttons
 * are off without it. A Server's card is on its Infrastructure tab.
 */
export function GpuCard() {
  const gate = useInstanceGate();
  return (
    <GpuSupportCard
      serverId={null}
      machineName="the platform host"
      checkLabel="Check this host"
      gate={gate}
    />
  );
}
