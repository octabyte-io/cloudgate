import { useState } from "react";

import type { PickerOption } from "@/components/console/picker";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { notReadyYet } from "@/lib/api/endpoints/servers";
import type { Server } from "@/lib/api/endpoints/servers";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

/** The platform host's option in a create form's Server picker. */
export const THIS_CLOUDGATE_HOST = "This Cloudgate host";

/** What the picker says before a Server is chosen on the Hosted instance. */
export const CHOOSE_A_SERVER = "Choose a Server";

/** Said under the Server picker in a cloud Environment. */
export const CLOUD_TARGET_HINT =
  "This Environment deploys to a Cloud account, where only its Project config creates Services, so choose a Server, or this Cloudgate host on purpose.";

/**
 * The platform host option's value where `""` has to mean nothing chosen: an
 * Environment whose Deploy target is a Cloud account. Unspellable as
 * a server id, like the Picker's own sentinel.
 */
const HOST_CHOSEN = "__cloudgate_platform_host__";

/**
 * Where a Service create form offers to put it
 * this
 * Cloudgate host, then each Server.
 *
 * **On the Hosted instance the host is not offered** (ADR-0053): the API
 * refuses a Service there with `PLATFORM_HOST_REFUSED`, so the option is left
 * out rather than shown greyed, as the Deploy target picker does
 * (`deployTargetOptions`). The picker then opens on nothing chosen, and a
 * submit without a choice is answered by the API's own sentence.
 *
 * **In a cloud Environment the host is offered but never assumed**
 * only a
 * plan creates in a Cloud account, so the picker opens on nothing chosen and
 * the creator picks a Server or this Cloudgate host. A submit without a
 * choice leaves `serverId` out, which the API answers with its own sentence,
 * as on the Hosted instance. Everywhere else the host is the Picker's `""`.
 *
 * **It opens on a Server when the Organization has one Ready** (#147), not
 * on the host: a Service on Cloudgate's own machine is lost with Cloudgate's
 * records, and the form shows `SameMachineNote` while the host, or a Server
 * that is Cloudgate's own machine (#149), is chosen (`onSameMachine`). With
 * none Ready, the host stays the default. Neither changes
 * in a cloud Environment or on the Hosted instance.
 *
 * Used by the Application, AI model, Compose and database create forms, and
 * by the template and AI deploy forms.
 */
export function useCreateServerPicker(deployTarget: DeployTarget | undefined) {
  // Fails closed: until the mode has loaded (or if it fails to), the host is
  // not offered — a Hosted console must never show it, even for a moment.
  const platformHost = useInstanceMode().data === "self-hosted";
  const hostAsked = platformHost && deployTarget?.kind === "cloud";
  /**
   * The body's `serverId` for what the picker holds: a Server's id, `null`
   * for this Cloudgate host, and `undefined` — left out of the body — for
   * nothing chosen where the host is not assumed.
   */
  const serverIdOf = (value: string): string | null | undefined => {
    if (value === HOST_CHOSEN) return null;
    if (value !== "") return value;
    return hostAsked ? undefined : null;
  };
  return {
    /** Whether this Cloudgate host is a choice here. */
    platformHost,
    /**
     * Whether the field may be left alone: exactly while this Cloudgate host
     * is the Picker's `""`, so nothing chosen is the host. Not in a cloud
     * Environment, and not on the Hosted instance.
     */
    optional: platformHost && !hostAsked,
    placeholder:
      platformHost && !hostAsked ? THIS_CLOUDGATE_HOST : CHOOSE_A_SERVER,
    /**
     * The options, host first when it is offered. `label` names a host:
     * `null` is this Cloudgate host, else the Server. A Bought Server that is
     * not Ready yet is greyed out, saying why, as the Deploy target picker does.
     */
    options(
      servers: readonly Server[] | undefined,
      label: (name: string, serverId: string | null) => string = (name) => name,
    ): PickerOption[] {
      return [
        ...(platformHost
          ? [
              {
                value: hostAsked ? HOST_CHOSEN : "",
                label: label(THIS_CLOUDGATE_HOST, null),
              },
            ]
          : []),
        ...(servers ?? []).map((server) => {
          const notReady = notReadyYet(server);
          return {
            value: server.serverId,
            label: label(server.name, server.serverId),
            detail: notReady ?? server.ipAddress,
            disabled: notReady !== null,
          };
        }),
      ];
    },
    /**
     * The field's hint: `onHost` where this Cloudgate host is the default,
     * `onServers` where only Servers are offered, and in a cloud Environment
     * `onServers` with why the host has to be picked on purpose.
     */
    hint(onHost: string, onServers: string): string {
      if (hostAsked) return `${onServers} ${CLOUD_TARGET_HINT}`;
      return platformHost ? onHost : onServers;
    },
    serverIdOf,
    /**
     * What the picker opens on (#147): the first Ready deploy Server where
     * this Cloudgate host would otherwise be assumed, else the Picker's `""`
     * (the host, or nothing chosen in a cloud Environment and on the Hosted
     * instance, as before).
     */
    initial(servers: readonly Server[] | undefined): string {
      if (!platformHost || hostAsked) return "";
      return firstReadyDeployServer(servers)?.serverId ?? "";
    },
    /**
     * Whether what the picker holds puts the Service on Cloudgate's own
     * machine: this Cloudgate host, or a Server whose address is the box
     * (`sameMachine`, #149). The form then shows the Same-machine warning
     * (`SameMachineNote`).
     */
    onSameMachine(
      value: string,
      servers: readonly Server[] | undefined,
    ): boolean {
      if (!platformHost) return false;
      const serverId = serverIdOf(value);
      if (serverId === null) return true;
      return isSameMachineServer(servers, serverId);
    },
  };
}

/**
 * The platform host as a Deploy target `Picker` value
 * (`features/environment/deploy-target.ts`). A value of its own rather than
 * the Picker's `""`, because on a new Environment `""` already means "not
 * chosen yet" — and `CONTEXT.md` is plain that the platform host is a choice
 * made, never an unset one. A Server id is a nanoid, which never spells this.
 */
export const PLATFORM_HOST_VALUE = "platform-host";

/**
 * Whether a Deploy target Picker value is Cloudgate's own machine, where the
 * Same-machine warning shows: This Cloudgate host, or a Server whose address
 * is the box (`sameMachine`, #149). The Deploy target's counterpart of a
 * create picker's own `onSameMachine`, whose values spell the host as `""`.
 */
export function deployTargetOnSameMachine(
  value: string,
  servers: readonly Server[] | undefined,
): boolean {
  return value === PLATFORM_HOST_VALUE || isSameMachineServer(servers, value);
}

/**
 * Whether `serverId` names a Server whose address is Cloudgate's own machine
 * (`sameMachine`, #149), so choosing it gets the Same-machine warning as
 * this Cloudgate host does. Shared with the Deploy target pickers.
 */
export function isSameMachineServer(
  servers: readonly Server[] | undefined,
  serverId: string | null | undefined,
): boolean {
  return (
    (servers ?? []).find((server) => server.serverId === serverId)
      ?.sameMachine === true
  );
}

/**
 * The deploy Server a create opens on rather than this Cloudgate host
 * (#147): the first that is Ready, so nobody lands on Cloudgate's own
 * machine by not looking. Undefined with none, where the host stays the
 * default. Shared with a new Environment's Deploy target and Template setup.
 */
export function firstReadyDeployServer(
  servers: readonly Server[] | undefined,
): Server | undefined {
  return (servers ?? []).find(
    (server) => server.serverType === "deploy" && notReadyYet(server) === null,
  );
}

/**
 * The picker's value: what the person picked or, until they pick, what it
 * opens on, which follows the Server list as it arrives since a form mounts
 * before that read answers.
 */
export function useServerChoice(
  initial: string,
): [string, (value: string) => void] {
  const [picked, setPicked] = useState<string | null>(null);
  return [picked ?? initial, setPicked];
}
