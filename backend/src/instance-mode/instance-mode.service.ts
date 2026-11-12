import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { InstanceModeName } from './instance-mode';
import { platformHostRefused } from './platform-host-refusal';
import type { PlatformHostWork } from './platform-host-refusal';

/**
 * The one answer to "is this the Hosted instance?" (ADR-0049).
 *
 * Every hosted rule asks this — billing, sign-up, refusing the platform host,
 * plan features — and nothing else reads `HOSTED_MODE`
 * (`test/coding-standards/instance-mode-reads.spec.ts`). The setting is read
 * off ConfigService, after `checkInstanceModeBoot` has passed it in
 * `validateEnv`, so a value this sees is one the boot check accepted.
 *
 * Global (`InstanceModeModule`), so a module needs no import to ask it.
 *
 * In an e2e, hosted mode is turned on before the app module is imported, with
 * `useHostedMode()` from `test/utils/hosted-mode.ts`.
 */
@Injectable()
export class InstanceMode implements OnApplicationBootstrap {
  private readonly logger = new Logger(InstanceMode.name);

  constructor(private readonly config: ConfigService) {}

  /** Whether this Instance is the Hosted instance. */
  get isHosted(): boolean {
    return this.config.get<boolean>('HOSTED_MODE') === true;
  }

  /** The same answer as `GET /settings/about` and the boot log spell it. */
  get mode(): InstanceModeName {
    return this.isHosted ? 'hosted' : 'self-hosted';
  }

  /**
   * **The** platform-host refusal (ADR-0053): on the Hosted instance,
   * throws 400 `PLATFORM_HOST_REFUSED` with `work`'s sentence; on a
   * Self-hosted one, returns and changes nothing.
   *
   * A caller reaches it once it knows the work would land on the platform
   * host (an absent `serverId`, a `platform-host` Deploy target), never to
   * ask whether it might. It refuses every Organization alike, the Instance
   * organization's included: instance authority manages the box, it does not
   * get Services on it. Where it is called is held by
   * `test/coding-standards/platform-host-census.spec.ts`.
   */
  refusePlatformHost(work: PlatformHostWork): void {
    if (this.isHosted) throw platformHostRefused(work);
  }

  /** The boot log line an operator confirms the mode by. */
  onApplicationBootstrap(): void {
    this.logger.log(`Instance mode: ${this.mode}`);
  }
}
