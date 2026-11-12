import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  compose,
  dnsChallenge,
  domain,
  forwardAuthSettings,
} from '../db/schema';
import { prepareEnvironmentVariables } from '../docker/docker.utils';
import { dnsChallengeOn } from './dns-challenge.read';
import { DNS_CHALLENGE_RESOLVER } from './dns-challenge.schema';
import { toDnsChallengeView } from './dns-challenge.utils';
import type { DnsChallengeView } from './dns-challenge.utils';
import { DockerResourceService } from './docker-resource.service';
import {
  TraefikFilesService,
  TRAEFIK_CONTAINER_NAME,
} from './traefik-files.service';
import { TraefikSetupService } from './traefik-setup.service';

/** The machine-readable name of the `409` a DELETE in use answers. */
export const DNS_CHALLENGE_IN_USE_CODE = 'DNS_CHALLENGE_IN_USE';

/** `column` names this machine: `serverId`, or the platform host when null. */
const onMachine = (column: AnyPgColumn, serverId: string | null) =>
  serverId ? eq(column, serverId) : isNull(column);

/** The names joined for a sentence, and the pronoun that stands for them. */
const listed = (names: string[]) => ({
  names: names.join(', '),
  them: names.length === 1 ? 'it' : 'them',
});

/** What a PUT carries once the controller has resolved the machine. */
export interface DnsChallengeInput {
  provider: string;
  credentials?: Record<string, string>;
}

/**
 * A machine's DNS-01 setup: the lego provider and credentials a
 * `dns_challenge` row holds, the resolver it puts in that machine's
 * `traefik.yml`, and the credentials it puts in that machine's Traefik env.
 *
 * Authority is the caller's: every method here is reached only through
 * `SettingsController.traefikTargetAuthority`, as the other Traefik routes are.
 */
@Injectable()
export class DnsChallengeService {
  private readonly logger = new Logger(DnsChallengeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly traefikFiles: TraefikFilesService,
    private readonly traefikSetup: TraefikSetupService,
    private readonly dockerResources: DockerResourceService,
  ) {}

  /** The machine's provider and credential key names, or null; no values. */
  async view(serverId: string | null): Promise<DnsChallengeView | null> {
    const row = await dnsChallengeOn(this.db, serverId);
    return row ? toDnsChallengeView(row) : null;
  }

  /**
   * Traefik's env on the machine as `KEY=value` lines, with every key the
   * machine's DNS row names withheld (ADR-0019). The one read of Traefik's env
   * for `GET /settings/traefik/env` and for the writes that re-submit it —
   * those get the credentials back from `writeTraefikSetup`'s merge, and never
   * put a credential value through `prepareEnvironmentVariables`' `${{…}}`
   * resolution or dotenv's `#` handling on the way.
   */
  async traefikEnv(serverId: string | null | undefined): Promise<string> {
    const row = await dnsChallengeOn(this.db, serverId);
    return this.dockerResources.readEnvironmentVariables(
      TRAEFIK_CONTAINER_NAME,
      serverId,
      Object.keys(row?.credentials ?? {}),
    );
  }

  /**
   * Sets the machine's DNS provider and credentials, writes the DNS-01
   * resolver into its `traefik.yml`, and recreates its Traefik in the
   * background with the credentials in its env.
   *
   * Omitted credentials keep the stored map, which needs one to exist (400
   * otherwise); a provided map replaces it whole, and a key that was in the old
   * map and not the new one is taken off Traefik's env.
   *
   * `traefik.yml` is written first, because it is the half that can refuse —
   * no config (404), or no `letsencrypt` resolver to copy from (409) — and a
   * refusal must leave no row behind naming a resolver that was never written.
   *
   * The row is one upsert on the machine key rather than a read and then an
   * insert (§2.3): two PUTs racing on a machine with no row would otherwise
   * both insert, and the second would answer a unique-index 500 on a Server —
   * or, on the platform host before `0083_dns-challenge-local-unique.sql`, a
   * second row. The platform-host row is unique only through the partial
   * index `dns_challenge_local_unique`, so its conflict target carries that
   * index's `WHERE`. Omitted credentials leave the stored column alone, rather than
   * writing back the copy read above, which a racing PUT may have replaced.
   */
  async put(
    serverId: string | null,
    input: DnsChallengeInput,
  ): Promise<DnsChallengeView> {
    const current = await dnsChallengeOn(this.db, serverId);
    const credentials = input.credentials ?? current?.credentials;
    if (!credentials) {
      throw new BadRequestException(
        'Credentials are required when this machine has no DNS challenge yet',
      );
    }

    await this.traefikFiles.writeDnsChallengeResolver(input.provider, serverId);

    const [row] = await this.db
      .insert(dnsChallenge)
      .values({ serverId, provider: input.provider, credentials })
      .onConflictDoUpdate({
        target: dnsChallenge.serverId,
        targetWhere: serverId ? undefined : isNull(dnsChallenge.serverId),
        set: input.credentials
          ? { provider: input.provider, credentials: input.credentials }
          : { provider: input.provider },
      })
      .returning();

    this.recreateTraefik(serverId, [
      ...Object.keys(current?.credentials ?? {}),
      ...Object.keys(credentials),
    ]);
    return toDnsChallengeView(row);
  }

  /**
   * Removes the machine's DNS-01 setup: the row, the resolver in its
   * `traefik.yml`, and the credentials in its Traefik env.
   *
   * Refused with `409` while anything on this machine asks Traefik for the
   * {@link DNS_CHALLENGE_RESOLVER} resolver, naming each, so no router is left
   * asking for a resolver that no longer exists (see
   * {@link DnsChallengeService.relyingOn}); `404` when there is nothing to
   * remove.
   *
   * `traefik.yml` is rewritten before the row is deleted: the file write is the
   * half that can fail, and a failure then leaves the row, the resolver and
   * Traefik's env all as they were, rather than a resolver and credentials no
   * row accounts for.
   */
  async remove(serverId: string | null): Promise<true> {
    const current = await dnsChallengeOn(this.db, serverId);
    if (!current) {
      throw new NotFoundException('No DNS challenge is set up on this machine');
    }

    const relying = await this.relyingOn(serverId);
    if (relying.length > 0) {
      throw new ConflictException({
        message: relying.join('. '),
        code: DNS_CHALLENGE_IN_USE_CODE,
      });
    }

    await this.traefikFiles.writeDnsChallengeResolver(null, serverId);
    await this.db
      .delete(dnsChallenge)
      .where(eq(dnsChallenge.dnsChallengeId, current.dnsChallengeId));
    this.recreateTraefik(serverId, Object.keys(current.credentials));
    return true;
  }

  /**
   * One sentence per kind of thing on the machine whose router names the
   * DNS-01 resolver, empty when nothing does: an Application's previews with
   * its DNS-01 switch on; a Domain with a custom certificate naming the
   * resolver, whose machine is its Application's or Compose stack's `serverId`
   * (as `DomainsService.findParentService` resolves it); and the forward auth
   * proxy's own domain, configured the same way. Across Organizations, as the
   * machine's Traefik is.
   */
  private async relyingOn(serverId: string | null): Promise<string[]> {
    const previews = await this.db
      .select({ name: application.name })
      .from(application)
      .where(
        and(
          eq(application.previewDnsChallenge, true),
          onMachine(application.serverId, serverId),
        ),
      )
      .orderBy(application.name);

    const domains = await this.db
      .select({ host: domain.host })
      .from(domain)
      .leftJoin(
        application,
        eq(domain.applicationId, application.applicationId),
      )
      .leftJoin(compose, eq(domain.composeId, compose.composeId))
      .where(
        and(
          eq(domain.certificateType, 'custom'),
          eq(domain.customCertResolver, DNS_CHALLENGE_RESOLVER),
          or(
            and(
              isNotNull(domain.applicationId),
              onMachine(application.serverId, serverId),
            ),
            and(
              isNotNull(domain.composeId),
              onMachine(compose.serverId, serverId),
            ),
          ),
        ),
      )
      .orderBy(domain.host);

    const forwardAuth = await this.db
      .select({ authDomain: forwardAuthSettings.authDomain })
      .from(forwardAuthSettings)
      .where(
        and(
          eq(forwardAuthSettings.certificateType, 'custom'),
          eq(forwardAuthSettings.customCertResolver, DNS_CHALLENGE_RESOLVER),
          onMachine(forwardAuthSettings.serverId, serverId),
        ),
      );

    const sentences: string[] = [];
    if (previews.length > 0) {
      const { names, them } = listed(previews.map((row) => row.name));
      sentences.push(
        `Previews of ${names} issue their certificate through this DNS challenge; turn that off on ${them} first`,
      );
    }
    if (domains.length > 0) {
      const { names, them } = listed(domains.map((row) => row.host));
      sentences.push(
        `${domains.length === 1 ? 'Domain' : 'Domains'} ${names} ${domains.length === 1 ? 'issues its' : 'issue their'} certificate through this DNS challenge; give ${them} another certificate first`,
      );
    }
    if (forwardAuth.length > 0) {
      sentences.push(
        `Forward auth on ${forwardAuth[0].authDomain} issues its certificate through this DNS challenge; give it another certificate first`,
      );
    }
    return sentences;
  }

  /**
   * Recreates the machine's Traefik from its current env less `staleKeys` and
   * its current ports; `writeTraefikSetup` then merges in whatever credentials
   * the row now holds. Fire-and-forget, as every other Traefik recreate here
   * is: the request that caused it may itself be arriving through that
   * Traefik, and must be answered before it goes down.
   */
  private recreateTraefik(
    serverId: string | null,
    staleKeys: readonly string[],
  ): void {
    const run = async () => {
      const env = await this.dockerResources.readEnvironmentVariables(
        TRAEFIK_CONTAINER_NAME,
        serverId,
        staleKeys,
      );
      const additionalPorts = await this.dockerResources.readPorts(
        TRAEFIK_CONTAINER_NAME,
        serverId,
      );
      await this.traefikSetup.writeTraefikSetup({
        env: prepareEnvironmentVariables(env),
        additionalPorts,
        serverId,
      });
    };
    // The error's message only: the recreate carries Traefik's env, and with
    // it this machine's DNS credentials, which nothing here may log.
    void run().catch((err: unknown) => {
      this.logger.error(
        `Recreating Traefik with its DNS challenge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
