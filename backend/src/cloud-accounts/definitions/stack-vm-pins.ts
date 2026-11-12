import type { CloudKind } from '../cloud-account.schema';
import { byCloud } from '../cloud-provider';
import type { PerCloud } from '../cloud-provider';

/**
 * **What a Stack VM is made from, pinned** (ADR-0070 "Image and Docker"):
 * each cloud's build of Canonical's Ubuntu 24.04 LTS, and the Docker
 * Engine and compose plugin cloud-init installs on its first boot, as
 * Ubuntu 24.04's apt versions from Docker's own repository, held so `apt`
 * never moves them. Pinned beside the OpenTofu pins, in
 * `deploy/opentofu/stack-vm.json`, which `opentofu-pins.spec.ts` holds
 * these equal to. A pin that moves is a "replace VM" plan line (#1368),
 * never a silent upgrade: a made Stack VM keeps the pins it was made with
 * until an approved replace moves them.
 */
export const DOCKER_ENGINE_VERSION = '5:29.9.2-1~ubuntu.24.04~noble';

/** The `docker-compose-plugin` apt version every Stack VM installs. */
export const COMPOSE_PLUGIN_VERSION = '5.6.1-1~ubuntu.24.04~noble';

/**
 * The one Ubuntu 24.04 build each cloud's Stack VM boots, by the name
 * Canonical publishes it under: on AWS the AMI name in each region
 * (Canonical's own account), on Google Cloud the image in
 * `ubuntu-os-cloud`. Never a family's latest, so the OS moves only when
 * this pin does.
 */
export const UBUNTU_IMAGES: PerCloud<string> = {
  aws: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261017',
  gcp: 'ubuntu-2404-noble-amd64-v20261105',
};

/** The pins a Stack VM was made with, as its stack's settings record them. */
export interface StackVmPins {
  /**
   * The pinned Ubuntu image it was made from, by name ({@link UBUNTU_IMAGES});
   * absent on a Stack VM recorded before the image was pinned, which reads
   * as a pin that moved.
   */
  readonly image?: string;
  readonly dockerEngine: string;
  readonly composePlugin: string;
}

/** The pins a Stack VM made now on a cloud runs. */
export function stackVmPinsOn(cloud: CloudKind): Required<StackVmPins> {
  return {
    image: byCloud(cloud, UBUNTU_IMAGES),
    dockerEngine: DOCKER_ENGINE_VERSION,
    composePlugin: COMPOSE_PLUGIN_VERSION,
  };
}

/**
 * Which of a made Stack VM's pins Cloudgate has moved since: what a
 * "replace VM" line names. Empty when it runs what Cloudgate pins now.
 */
export function movedPins(
  made: StackVmPins,
  now: Required<StackVmPins>,
): readonly {
  readonly pin: 'image' | 'dockerEngine' | 'composePlugin';
  readonly from: string | null;
  readonly to: string;
}[] {
  return (['image', 'dockerEngine', 'composePlugin'] as const).flatMap((pin) =>
    made[pin] === now[pin]
      ? []
      : [{ pin, from: made[pin] ?? null, to: now[pin] }],
  );
}
