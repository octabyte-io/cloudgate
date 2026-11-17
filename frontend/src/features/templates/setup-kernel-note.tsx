import {
  MongoKernelNote,
  isMongo8Image,
  useMongoRefusedKernel,
} from "@/components/console/mongo-kernel";
import type { SetupForm } from "@/lib/api/endpoints/templates";

import {
  PLATFORM_HOST_VALUE,
  cloudAccountOf,
} from "../environment/deploy-target";

/**
 * Said before Set up when the Template runs a MongoDB 8 and the machine it
 * is going to refuses it (#104) — how Ackee was found restarting forever on
 * an Ubuntu 26.04 Server while its Deployment read done.
 *
 * The machine is the picked Environment's (`machine`, from the setup form),
 * or for a new Project the picked Deploy target's. A Cloud Environment has
 * none: its Stack VM is Cloudgate's to make and no kernel reading reaches it.
 * A warning, never a refusal: the kernel can be updated after setup.
 */
export function SetupKernelNote({
  setup,
  environmentId,
  newProjectTarget,
}: {
  setup: SetupForm;
  /** The Environment picked, for an existing Project. */
  environmentId: string;
  /** The Deploy target picked, its Picker value, for a new Project. */
  newProjectTarget: string | null;
}) {
  const mongo = setup.images.filter(isMongo8Image);
  const serverId =
    newProjectTarget === null
      ? setup.environments.find((env) => env.environmentId === environmentId)
          ?.machine?.serverId
      : machineOf(newProjectTarget);
  const kernel = useMongoRefusedKernel(serverId, mongo.length > 0);
  if (!kernel) return null;
  return (
    <MongoKernelNote
      kernel={kernel}
      host={serverId === null ? "the platform host" : "this Server"}
    >
      {setup.templateName} runs{" "}
      <code className="font-mono">{mongo.join(", ")}</code>.
    </MongoKernelNote>
  );
}

/** A Deploy target's machine: a Server's id, null for the platform host. */
function machineOf(target: string): string | null | undefined {
  if (target === "" || cloudAccountOf(target) !== null) return undefined;
  return target === PLATFORM_HOST_VALUE ? null : target;
}
