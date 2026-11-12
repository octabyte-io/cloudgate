import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { platformHostRefused } from '../../src/instance-mode/platform-host-refusal';

/**
 * An `InstanceMode` for a unit spec that builds a service by hand: its
 * platform-host refusal (ADR-0053) decides exactly as the real one does,
 * on the mode given.
 */
export const instanceModeDouble = (isHosted: boolean): InstanceMode =>
  ({
    isHosted,
    mode: isHosted ? 'hosted' : 'self-hosted',
    refusePlatformHost: (work: 'services' | 'checks') => {
      if (isHosted) throw platformHostRefused(work);
    },
  }) as unknown as InstanceMode;

/** The mode every spec built before hosted mode existed assumes. */
export const SELF_HOSTED = instanceModeDouble(false);
