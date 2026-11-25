import { useFormContext, useWatch } from "react-hook-form";

import { SameMachineNote } from "@/components/console/same-machine";
import type { Server } from "@/lib/api/endpoints/servers";
import type { SetupForm } from "@/lib/api/endpoints/templates";
import {
  deployTargetOnSameMachine,
  isSameMachineServer,
  PLATFORM_HOST_VALUE,
} from "@/lib/forms/create-server-picker";

import type { NewProjectTarget } from "./new-project-targets";
import type { SetupValues } from "./setup-values";

/**
 * Template setup's part of the Same-machine warning (spec #146): shown while
 * the setup goes to Cloudgate's own machine — This Cloudgate host, or a
 * Server that is the box (#149) — as a new Project's Deploy target
 * (`creating`) or as the Environment picked. Reads both from the setup form
 * it sits in, as the asked fields do (`setup-fields.tsx`).
 */
export function SetupSameMachineNote({
  setup,
  servers,
  creating,
}: {
  setup: SetupForm;
  /** The Organization's Servers, to tell one that is Cloudgate's own machine. */
  servers: readonly Server[] | undefined;
  /** A new Project's setup, whose place is its Deploy target. */
  creating: boolean;
}) {
  const { control } = useFormContext<SetupValues>();
  const [environmentId, target] = useWatch({
    control,
    name: ["environmentId", "newProject.target"],
  });
  const machine = setup.environments.find(
    (env) => env.environmentId === environmentId,
  )?.machine;
  const sameMachine = creating
    ? deployTargetOnSameMachine(target ?? "", servers)
    : machine?.serverId === null ||
      isSameMachineServer(servers, machine?.serverId);
  return sameMachine ? <SameMachineNote /> : null;
}

/**
 * The Deploy target a new Project opens on: the first Ready deploy Server
 * that can take the template (#147), so it does not land on Cloudgate's own
 * machine by default, else the first target that can.
 */
export function firstTargetOf(targets: readonly NewProjectTarget[]): string {
  const takes = targets.filter((one) => one.reason === null);
  const server = takes.find(
    (one) =>
      one.cloud === null && one.value !== PLATFORM_HOST_VALUE && !one.disabled,
  );
  return (server ?? takes[0])?.value ?? "";
}
