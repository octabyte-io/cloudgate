import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { webServerSettings } from '../db/schema';
import { instanceOwnHosts } from '../domains/instance-hosts';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { ADDRESS_RESOLVER, bareHost } from './outbound-address';
import type { AddressResolver } from './outbound-address';

/**
 * The box's own addresses: the one list both address guards refuse on the
 * Hosted instance (ADR-0053). `ServerAddressGuard` refuses them as a Server's
 * address, and `OutboundAddressGuard` as the host of a customer's dial, so a
 * customer cannot make the box dial itself at its public address on any port
 * (its backend, console or Swarm ports, without Traefik in front).
 */
@Injectable()
export class OwnAddresses {
  constructor(
    @Inject(ADDRESS_RESOLVER) private readonly resolve: AddressResolver,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The box's own addresses: every interface's, and the public ones it is
   * configured with, which on a cloud VM behind NAT are on no interface —
   * Settings > Web server's `serverIp`, the install's `CLOUDGATE_PUBLIC_HOST`
   * (the Hosted install writes it into the backend's environment), and the
   * hosts of the Instance's own origins (`SITE_URL` and its siblings, whose
   * hostname's A record the Hosted install requires to point here). A name is
   * resolved; one that does not resolve adds nothing.
   */
  async list(): Promise<string[]> {
    const onInterfaces = Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map((entry) => entry.address),
    );
    const settings = await this.db
      .select({ serverIp: webServerSettings.serverIp })
      .from(webServerSettings);
    const configured = settings
      .map((row) => row.serverIp?.trim() ?? '')
      .filter((ip) => ip !== '');
    const publicHost =
      this.config.get<string>('CLOUDGATE_PUBLIC_HOST')?.trim() ?? '';
    const names = [
      ...(publicHost === '' ? [] : [bareHost(publicHost)]),
      ...instanceOwnHosts((name) => this.config.get<string>(name)),
    ];
    const resolved = await Promise.all(
      names.map(async (name) => {
        if (isIP(name) !== 0) return [name];
        try {
          return await this.resolve(name);
        } catch {
          return [];
        }
      }),
    );
    return [...onInterfaces, ...configured, ...resolved.flat()];
  }

  /**
   * {@link list} on the Hosted instance, and nothing on a Self-hosted one,
   * where the box dialling itself is a normal thing for its operator to set
   * up.
   */
  async listOnHosted(): Promise<string[]> {
    return this.instanceMode.isHosted ? this.list() : [];
  }
}
