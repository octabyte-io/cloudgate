import type { FieldSpec } from "@/components/console/form-spec";
import type { PickerOption } from "@/components/console/picker";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useServers } from "@/lib/api/use-servers";

/**
 * Where a credential probe runs from on the Hosted instance
 * one of the
 * Organization's Servers, never the platform host.
 *
 * A destination's Test connection (rclone) and a registry's (`docker login`)
 * run with the customer's credentials, so on the Hosted instance the API
 * refuses them on Cloudgate's own host with `PLATFORM_HOST_REFUSED` and the
 * checks sentence. The dialog asks which Server instead. Self-hosted it asks
 * nothing and the probe runs on this host as before.
 */
export type ProbeFrom = {
  options: PickerOption[];
  pending: boolean;
};

/** The probe-from picker's choices, or `null` when the instance does not ask. */
export function useProbeServerPicker(): ProbeFrom | null {
  // Fails closed: until the mode has loaded (or if it fails to), the probe
  // asks for a Server rather than running on this host.
  const hosted = useInstanceMode().data !== "self-hosted";
  const servers = useServers();
  if (!hosted) return null;
  return {
    options: (servers.data ?? []).map((server) => ({
      value: server.serverId,
      label: server.name,
      detail: server.ipAddress,
    })),
    pending: servers.isPending,
  };
}

/** The field a probe's dialog adds, on `serverId`. */
export function probeServerField<Values extends { serverId: string }>(
  from: ProbeFrom,
): FieldSpec<Values> {
  const none = !from.pending && from.options.length === 0;
  return {
    kind: "select",
    name: "serverId",
    label: "Test from",
    options: from.options,
    pending: from.pending,
    placeholder: none ? "No Servers yet" : "Choose a Server",
    hint: none
      ? "A test runs from one of your Servers, and you have none yet. Add a Server first."
      : "A test runs from one of your Servers, with the credentials in this dialog. This Cloudgate doesn't run checks on its own host.",
  };
}

/** Why the probe cannot run yet, or `null`. */
export function probeServerBlocked(
  from: ProbeFrom | null,
  values: { serverId: string },
): string | null {
  return from && !values.serverId
    ? "Choose a Server to test from. This Cloudgate doesn't run checks on its own host."
    : null;
}
