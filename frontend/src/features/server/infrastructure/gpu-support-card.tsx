import { GpuSupportCard } from "@/components/console/gpu-support-card";
import type { Server } from "@/lib/api/endpoints/servers";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

/**
 * This Server's GPU support, the card the platform host has on
 * Instance settings.
 *
 * **The gate is `server: ['create']`**, which the owner and admin roles hold
 * and the member role does not: both `/settings/gpu` routes take
 * `maintenanceTargetAuthority`, whose Server branch is owner-or-admin plus
 * access to this Server. Unlike the DNS-01 card, the read cannot answer the
 * gate itself, because the check is behind the very button being gated.
 */
export function ServerGpuSupportCard({ server }: { server: Server }) {
  const verdict = usePermission({ server: ["create"] });
  const gate = {
    allowed: verdict.allowed,
    refusal: roleRefusal("set up GPU support on a Server"),
  };
  return (
    <GpuSupportCard
      serverId={server.serverId}
      machineName={server.name}
      checkLabel="Check this Server"
      gate={gate}
    />
  );
}
