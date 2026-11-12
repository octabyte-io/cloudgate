import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  byCloud,
  CLOUD_NAMES,
  cloudOrLegacy,
} from '../cloud-accounts/cloud-provider';
import type { PerCloud } from '../cloud-accounts/cloud-provider';
import { checkServerAccess } from '../common/owned-server';
import { withUnreclaimedArtifacts } from '../common/teardown-steps';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import type { ComposeDomain } from '../compose/compose.types';
import {
  composeServiceUsesMapFormLabels,
  mapFormLabelsRefusal,
} from '../compose/compose.utils';
import {
  application,
  bucket,
  cloudAccount,
  compose,
  domain,
  environment,
  project,
  webServerSettings,
} from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { TraefikAppConfigService } from '../traefik/app-config.service';
import { composeStackConfigName } from '../traefik/config/names';
import { rewriteRoutingForDelete } from '../traefik/routing-delete';
import { GARAGE_S3_PORT } from '../buckets/garage';
import { bucketDomainRefusal } from './bucket-domain';
import { ipLiteral } from './ip-literal';
import { storedDomainRoutingSchema } from './dto/domain.dto';
import {
  coveringCertificate,
  storedCertificatesOn,
  withStoredCertificates,
} from './stored-certificate';
import { assertNotAiModelForDomain } from '../ai-models/ai-model-locks';
import { assertApplicationKindAllows } from '../applications/config-kind-locks';
import type { CertificateType, Domain } from './domain.schema';
import {
  certificateDeadline,
  CERTIFICATES_PER_LOAD_BALANCER,
  cloudDomainRefusal,
  dnsRecordsOf,
  QUOTA_REFUSAL,
  recordsLeftBehind,
} from './cloud-domain';
import type { DomainCloudName, PointTarget } from './cloud-domain';
import { ONE_DOMAIN_REFUSAL } from '../cloud-accounts/aws/definitions/static-definition';
import { CLOUD_DOMAIN_RUNNER } from './cloud-domain-runner.port';
import { LicenseService } from '../enterprise/license/license.service';
import { paidFeatureRefusal } from '../enterprise/license/paid-features';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import type { CloudDomainRunner } from './cloud-domain-runner.port';
import type { CreateDomainDto, UpdateDomainDto } from './dto/domain.dto';
import { certificateOf } from './certificate-of';
import { instanceOwnHosts } from './instance-hosts';
import type { StackVmRoute } from '../compose/stack-vm-ports';

/** The parent an application domain regenerates Traefik config for. */
type ParentService = {
  serviceId: string;
  appName: string;
  serverId: string | null;
  /** A bucket on a Server is a Domain's third parent. */
  type: 'application' | 'compose' | 'bucket';
  /** A Compose parent's kind, which decides how its Domains reach Traefik. */
  composeType?: 'docker-compose' | 'stack';
  /** The Environment an Application parent is in. */
  environmentId?: string;
  /**
   * An Application parent in a Cloud account, or a Compose stack on its
   * Stack VM (#1371): its Domains go on the cloud's load balancer through a
   * Cloud run, never on Traefik. A bucket parent in one takes no Domain at
   * all.
   */
  cloudAccountId?: string | null;
  /**
   * An Application parent's Config kind: a `static` one in a Cloud account
   * has its Domain on its own CloudFront distribution.
   */
  configKind?: string | null;
  /**
   * The cloud of a cloud parent's Cloud account: on Google Cloud its
   * Domains are rules on the Environment network.
   */
  cloud?: 'aws' | 'gcp' | null;
};

/**
 * The three columns the map-form pre-flight reads off a Compose stack —
 * which flavour decides where labels live, and where the definition is.
 */
type ComposeDefinition = Pick<
  typeof compose.$inferSelect,
  'sourceType' | 'composeType' | 'composeFile'
>;

/** The transaction handle a write runs inside, as notifications.service.ts spells it. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * Either handle the claim and route checks can read through: a
 * transaction, for the check that guards a write, or the pooled `db`, for the
 * pre-flight that has no write to guard yet. Both only ever read, so neither
 * cares which.
 */
type ClaimReader = Tx | DrizzleDB;

/**
 * The one refusal for a hostname this instance will not hand out.
 *
 * **It must never name the holder.** "Already used by <organization>" would
 * confirm another organization's existence, and its hostnames, to any member
 * holding `domain:['create']` — which `memberRole` does
 * (`rbac/access-control.ts:133`), so the oracle would be open to every base
 * member. The console-host refusal and the cross-organization refusal are
 * byte-identical for the same reason: a caller who can tell "the console holds
 * this" from "someone else holds this" apart can still enumerate. Same
 * precedent as `CONTAINER_DENIAL_MESSAGE` (ADR-0008), where two causes
 * share one wire shape and the distinction goes nowhere the caller can read.
 */
const HOST_CLAIMED_MESSAGE = 'This hostname is already in use';

/**
 * The refusal {@link DomainsService.generateDomain} answers with when the
 * platform host has no address to write into a name.
 *
 * It names the screen because there is exactly one thing to do about it, and
 * the alternative was what this replaces: a host handed over as though it
 * worked.
 *
 * One sentence and no trailing period, which is what §2.5 asks of a message
 * the exception filter renders — the colon carries the instruction the way
 * `NOT_A_DOCKER_INSTALL_REFUSAL` does. An earlier draft was two sentences and
 * cited `SettingsService`' console-host sweep as precedent for that: the
 * precedent does not hold, because that string is a `logger.error` an operator
 * never sees through the API, and of the messages actually thrown in
 * `backend/src` only `INERT_SCRIPT_REFUSAL` and `INERT_COMMAND_REFUSAL` carry
 * a period at all.
 */
const NO_PLATFORM_ADDRESS_MESSAGE =
  'A generated host carries an IP in its name and no IP is recorded for this Cloudgate host: set its public address in Settings → Instance, then generate again';

/**
 * Why a Stack VM's stack gets no generated host (ADR-0070, #1371): an
 * sslip.io name carries a Server's public address, and a Stack VM has none;
 * its Domains are rules on the cloud's load balancer, so the host is the
 * operator's own, typed, with the DNS records Cloudgate shows.
 */
export const NO_GENERATED_HOST_ON_STACK_VM =
  "A Stack VM has no generated host: an sslip.io name carries a Server's public address, and a Stack VM has none. Type a host of your own, then add the DNS records shown";

/**
 * The row `update` will leave behind: the stored row, overwritten only by the
 * keys the request body actually carries.
 *
 * `{...current, ...data}` is not this. `updateDomainSchema` is `.partial()`, and
 * a key a caller sent as an explicit `null` — which is how the console clears a
 * custom resolver — must win, while a key it omitted must not arrive as
 * `undefined` and erase the stored value. Filtering on `undefined` rather than
 * on falsiness is the same distinction `update`'s own
 * `...(data.host && { host })` makes one line further down.
 */
const withPatchApplied = <T extends object>(current: T, patch: object): T => ({
  ...current,
  ...(Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>),
});

@Injectable()
export class DomainsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly traefikAppConfig: TraefikAppConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Turning forward auth on through a Domain write is setting forward auth up,
   * so it asks the paid-feature check `ForwardAuthService.enableOnDomain` asks
   * (ADR-0054); otherwise this route would be the way round it. A write
   * that leaves the flag as it is, or turns it off, never asks: a Domain
   * already gated stays editable and stays gated whatever the plan.
   *
   * Through `ModuleRef` because LicenseModule is global and this module's
   * constructor is built by hand in several specs.
   */
  private async assertForwardAuthMayTurnOn(
    ctx: PermissionCtx,
    wasOn: boolean,
    next: boolean | undefined,
  ): Promise<void> {
    if (next !== true || wasOn) return;
    const license = this.moduleRef.get(LicenseService, { strict: false });
    if (await license.hasValidLicense(ctx.session.activeOrganizationId)) return;
    throw paidFeatureRefusal(
      this.moduleRef.get(InstanceMode, { strict: false }),
    );
  }

  /** The cloud Domains' runner, in a module that imports this one. */
  private get cloudRunner(): CloudDomainRunner {
    return this.moduleRef.get<CloudDomainRunner>(CLOUD_DOMAIN_RUNNER, {
      strict: false,
    });
  }

  /**
   * Domain permission plus row-level access to the parent service, insert
   * with the host trimmed.
   *
   * **The row is attached to the parent this method resolved, never to whatever
   * the body named.** It used to insert `{ ...data, host, path }`, which
   * writes *both* foreign keys, while {@link findParentService} tests
   * `applicationId` first and *returns* on that branch — so a body carrying the
   * caller's own `applicationId` beside another organization's `composeId` was
   * access-checked on the first id and landed a `domain` row on the victim's
   * Compose stack, whose Traefik router {@link findComposeDomains} splices into
   * their next deploy. Neither query was unscoped; the control flow was, which
   * is why the answer is about which id reaches the insert.
   *
   * `createDomainSchema` now refuses that body outright, and naming the columns
   * here is the other half rather than a duplicate of it: a refinement guards
   * the two fields it was written for, whereas naming the columns means *no*
   * caller-supplied key reaches the insert at all — the next foreign key this
   * DTO grows is inert by construction, and the service seam
   * (`PlanApplier`, `AiService.deploy`), which never passes
   * through the global pipe, obeys the same rule. A present-but-`undefined` key
   * is `DEFAULT` in drizzle's dialect, so every column the body omits still
   * lands exactly what the spread left it (confirmed in the dialect).
   *
   * The two pre-flights below it were the second consequence of the same bug
   * and are fixed by the same resolution: `assertHostUnclaimed` was handed the
   * *attacker's* `parent.serverId`, so the claim check asked about the wrong
   * machine's Traefik, and {@link assertComposeServiceRoutable} read the wrong
   * stack's compose file. Both read `parent`, so both now necessarily ask about
   * the service the row will hang off.
   */
  async create(ctx: PermissionCtx, data: CreateDomainDto) {
    const parent = await this.findParentService(ctx, data);
    await this.permissions.checkPermission(ctx, { domain: ['create'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    return this.insertDomain(ctx, parent, data);
  }

  /**
   * The same create, for the generated Domain of a `web` Service a Project
   * config plan creates (US38): part of that Service's create step, so
   * it is authorized by the step's own `service: create` on the Project, and
   * an Apply never needs a statement beyond the ones its steps' Services use
   * (US67) — no `domain: create`. The entitlement half, which Service, is
   * still asked at `'read'`, as `MountsService.createForNewService` asks it.
   */
  async createForNewService(ctx: PermissionCtx, data: CreateDomainDto) {
    const parent = await this.findParentService(ctx, data);
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    return this.insertDomain(ctx, parent, data);
  }

  /** The write both creates share, once their gates have run. */
  private async insertDomain(
    ctx: PermissionCtx,
    parent: ParentService,
    data: CreateDomainDto,
  ) {
    // An AI model is reached through its gateway endpoint alone, so nothing
    // may route a host to it. Every attach path — a create, a Project
    // config plan's generated Domain, a template's — lands here.
    // A web-private is reached only at its internal address, and a
    // worker serves no HTTP: both refused on the same every-path seam.
    if (parent.type === 'application') {
      await assertNotAiModelForDomain(this.db, parent.serviceId);
      await assertApplicationKindAllows(this.db, parent.serviceId, 'domain');
    }
    const host = data.host.trim();
    const path = data.path ?? '/';
    if (isCloud(parent)) {
      return this.insertCloudDomain(ctx, parent, data, host, path);
    }
    if (parent.type === 'bucket') {
      // A bucket on AWS is an S3 bucket with no Garage to route a host to
      // a bucket's Domain is a Server bucket's alone.
      if (parent.cloudAccountId) {
        throw new BadRequestException(
          'A bucket on AWS takes no Domain: it is reached at its S3 endpoint, and only a bucket on a Server has a Domain routed to its Garage',
        );
      }
      this.assertBucketFields(data);
    }
    await this.assertForwardAuthMayTurnOn(ctx, false, data.forwardAuthEnabled);
    // After the permission gate for the reason every other pre-flight
    // in this file is: a refusal that reads the caller's own stack must not be
    // reachable before the caller is entitled to it. Before the transaction, so
    // a refused attach is provably not stored.
    await this.assertComposeServiceRoutable(parent, host, data.serviceName);
    await this.assertStoredCertificateCovers(ctx, parent, {
      host,
      https: data.https,
      certificateType: data.certificateType,
    });
    const created = await this.db.transaction(async (tx) => {
      await this.assertRouteUntaken(tx, {
        host,
        path,
        organizationId: ctx.session.activeOrganizationId,
      });
      await this.assertHostUnclaimed(tx, {
        host,
        serverId: parent.serverId,
        organizationId: ctx.session.activeOrganizationId,
      });
      const [created] = await tx
        .insert(domain)
        .values({
          host,
          path,
          internalPath: data.internalPath,
          stripPath: data.stripPath,
          // A bucket's Domain reaches Garage's S3 API, whatever was sent.
          port: parent.type === 'bucket' ? GARAGE_S3_PORT : data.port,
          https: data.https,
          // None while HTTPS is off, whatever was sent. Named, not
          // spread, so no write to this table spreads a value.
          certificateType: certificateOf(data).certificateType,
          customCertResolver: certificateOf(data).customCertResolver,
          customEntrypoint: data.customEntrypoint,
          middlewares: data.middlewares,
          forwardAuthEnabled: data.forwardAuthEnabled,
          serviceName: data.serviceName,
          domainType: parent.type === 'bucket' ? 'bucket' : data.domainType,
          // The resolved parent, not `data.applicationId` / `data.composeId`
          // — the columns in this list that decide *whose* Traefik
          // this row reaches, and the only ones not read off the body.
          applicationId:
            parent.type === 'application' ? parent.serviceId : undefined,
          composeId: parent.type === 'compose' ? parent.serviceId : undefined,
          bucketId: parent.type === 'bucket' ? parent.serviceId : undefined,
        })
        .returning();
      return created;
    });

    await this.regenerateTraefikConfig(parent);
    return created;
  }

  /**
   * A Domain on a cloud `web` ("Domains"): the fields only
   * Traefik has are refused, each named, and HTTPS off; one Domain past the
   * load balancer's certificates quota is refused, naming it. The row is
   * stored with its cloud certificate waiting for DNS, and its own short
   * Cloud run is queued at once: it requests the certificate and adds the
   * host rule. Nothing reaches Traefik.
   */
  private async insertCloudDomain(
    ctx: PermissionCtx,
    parent: CloudParent,
    data: CreateDomainDto,
    host: string,
    path: string,
  ) {
    this.assertCloudFields(data, parent);
    const cloudFront = onCloudFrontWithPath(parent, path);
    const port = data.port ?? DEFAULT_DOMAIN_PORT;
    if (parent.type === 'compose') {
      assertStackVmService(data.serviceName);
    }
    await this.assertCloudRunnable(parent);
    const created = await this.db.transaction(async (tx) => {
      const organizationId = ctx.session.activeOrganizationId;
      if (parent.type === 'compose') {
        await this.assertStackVmPortFree(tx, parent.serviceId, {
          serviceName: data.serviceName!,
          port,
        });
      }
      if (cloudFront) await this.assertNoDomainYet(tx, parent.serviceId);
      else if (domainsOn(parent).hostAlone) {
        await this.assertHostAlone(tx, { host, organizationId });
      } else await this.assertUnderQuota(tx, parent.environmentId);
      await this.assertRouteUntaken(tx, {
        host,
        path,
        organizationId,
        cloud: true,
      });
      await this.assertHostUnclaimed(tx, { host, cloud: true, organizationId });
      const [created] = await tx
        .insert(domain)
        .values({
          host,
          path,
          port,
          https: true,
          ...(parent.type === 'compose'
            ? {
                domainType: 'compose' as const,
                composeId: parent.serviceId,
                serviceName: data.serviceName,
              }
            : {
                domainType: 'application' as const,
                applicationId: parent.serviceId,
              }),
          cloudCertificateStatus: 'waiting-for-dns',
        })
        .returning();
      return created;
    });
    const deploymentId = await this.queueCloudRun(parent, {
      title: `Add Domain ${host}`,
      description: runDescriptionOf(parent, 'add', { cloudFront, host, port }),
    });
    return { ...created, deploymentId };
  }

  /**
   * A `static` site on AWS takes one Domain: CloudFront serves one
   * certificate per distribution, and each Domain has its own.
   */
  private async assertNoDomainYet(
    tx: ClaimReader,
    applicationId: string,
  ): Promise<void> {
    const [{ held }] = await tx
      .select({ held: count() })
      .from(domain)
      .where(eq(domain.applicationId, applicationId));
    if (held > 0) throw new BadRequestException(ONE_DOMAIN_REFUSAL);
  }

  /** A bucket's Domain's fields, or a 400 naming the one it does not take. */
  private assertBucketFields(row: Parameters<typeof bucketDomainRefusal>[0]) {
    const refused = bucketDomainRefusal(row);
    if (refused) throw new BadRequestException(refused);
  }

  /** A cloud Domain's fields, or a 400 naming the one its cloud does not take. */
  private assertCloudFields(
    row: Parameters<typeof cloudDomainRefusal>[0],
    parent: CloudParent,
  ) {
    const refused = cloudDomainRefusal(row, cloudNameOf(parent));
    if (refused) throw new BadRequestException(refused);
  }

  /**
   * On Google Cloud a host is one Domain's: its certificate map
   * entry and DNS authorization are the host's own, so a second Domain on
   * the host, even by another path, is refused, naming why. Only the
   * Organization's own Domains count: another Organization's are in its own
   * Google project, and a cloud Domain's host is unique per Organization
   * (ADR-0060).
   */
  private async assertHostAlone(
    tx: ClaimReader,
    route: { host: string; organizationId: string; exceptDomainId?: string },
  ): Promise<void> {
    const [taken] = await tx
      .select({ domainId: domain.domainId })
      .from(domain)
      .where(
        and(
          sql`lower(${domain.host}) = lower(${route.host})`,
          heldBy(route.organizationId),
          route.exceptDomainId === undefined
            ? undefined
            : ne(domain.domainId, route.exceptDomainId),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ConflictException(
        `host: ${route.host} already has a Domain. On Google Cloud a host is one Domain, with its own certificate on the load balancer; give this one another host`,
      );
    }
  }

  /** The Service must have finished its first deploy; a stack, its Stack VM made. */
  private async assertCloudRunnable(parent: CloudParent): Promise<void> {
    const refused =
      parent.type === 'compose'
        ? await this.cloudRunner.stackRefusal(parent.serviceId)
        : await this.cloudRunner.refusal(parent.serviceId);
    if (refused) throw new BadRequestException(refused);
  }

  /** A cloud parent's Domain run, recorded and queued; its Deployment's id. */
  private queueCloudRun(
    parent: CloudParent,
    run: { title: string; description: string },
  ): Promise<string> {
    return parent.type === 'compose'
      ? this.cloudRunner.queueStack({ composeId: parent.serviceId, ...run })
      : this.cloudRunner.queue({ applicationId: parent.serviceId, ...run });
  }

  /** What a cloud parent's Domains point at, or `null` while it is not made. */
  private pointTargetOf(parent: CloudParent): Promise<PointTarget | null> {
    return parent.type === 'compose'
      ? this.cloudRunner.stackPointTarget(parent.serviceId)
      : this.cloudRunner.pointTarget(parent.serviceId);
  }

  /**
   * What a Compose stack's Domains in a Cloud Environment would point at,
   * before the stack exists: a Template's setup form shows the DNS records
   * for the hosts it types (#1379). `null` while its network is not made.
   * The caller has authorized the Environment.
   */
  stackNetworkPointTarget(place: {
    environmentId: string;
    cloudAccountId: string;
    region: string;
  }): Promise<PointTarget | null> {
    return this.cloudRunner.networkPointTarget(place);
  }

  /**
   * A Stack VM publishes a port once (`publishStackVmPorts`), so two
   * services' Domains cannot reach the same port; one service's Domains may
   * share it.
   */
  private async assertStackVmPortFree(
    tx: ClaimReader,
    composeId: string,
    route: { serviceName: string; port: number; exceptDomainId?: string },
  ): Promise<void> {
    const [taken] = await tx
      .select({ serviceName: domain.serviceName })
      .from(domain)
      .where(
        and(
          eq(domain.composeId, composeId),
          eq(domain.port, route.port),
          ne(domain.serviceName, route.serviceName),
          route.exceptDomainId === undefined
            ? undefined
            : ne(domain.domainId, route.exceptDomainId),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ConflictException(
        `port: service ${taken.serviceName}'s Domain already reaches port ${route.port} on this Stack VM, which publishes a port once. Give this Domain another port`,
      );
    }
  }

  /**
   * AWS's certificates-per-load-balancer quota: an Environment's cloud
   * Domains share its one load balancer, each with its own
   * certificate. A `static` site's is on its distribution, so it
   * does not count.
   */
  private async assertUnderQuota(
    tx: ClaimReader,
    environmentId: string,
  ): Promise<void> {
    const [{ held }] = await tx
      .select({ held: count() })
      .from(domain)
      .innerJoin(
        application,
        eq(domain.applicationId, application.applicationId),
      )
      .where(
        and(
          eq(application.environmentId, environmentId),
          isNotNull(domain.cloudCertificateStatus),
          sql`${application.configKind} is distinct from 'static'`,
        ),
      );
    // A Stack VM's Domains are on the same load balancer (#1371).
    const [{ onStacks }] = await tx
      .select({ onStacks: count() })
      .from(domain)
      .innerJoin(compose, eq(domain.composeId, compose.composeId))
      .where(
        and(
          eq(compose.environmentId, environmentId),
          isNotNull(domain.cloudCertificateStatus),
        ),
      );
    if (held + onStacks >= CERTIFICATES_PER_LOAD_BALANCER) {
      throw new BadRequestException(QUOTA_REFUSAL);
    }
  }

  /**
   * Regenerates the parent's config from scratch instead of patching it
   * (TraefikAppConfigService). An Application's Domains and a `stack`
   * Compose's are routed by the file provider, so both are rewritten
   * here; a `docker-compose` Compose's routers travel as labels injected at
   * deploy time, and get nothing here.
   *
   * **The routing guard runs above the compose early return on purpose.** It is
   * not a fact about the file provider; it is the assertion that every Domain
   * row of this parent is one Traefik can be given, and a compose stack's rows
   * reach Traefik too — later, as labels, through {@link findComposeDomains}.
   * Refusing the write that would have left a poisoned row in place tells the
   * operator at the console rather than at the next deploy.
   */
  private async regenerateTraefikConfig(
    parent: ParentService,
    db: DrizzleDB | DrizzleTx = this.db,
  ) {
    await this.assertParentRowsRoutable(parent, db);
    if (parent.type === 'bucket') {
      await this.traefikAppConfig.routeBucket(
        {
          bucketId: parent.serviceId,
          appName: parent.appName,
          serverId: parent.serverId,
        },
        db,
      );
      return;
    }
    if (parent.type === 'compose') {
      if (parent.composeType !== 'stack') return;
      await this.traefikAppConfig.routeComposeStack(
        {
          composeId: parent.serviceId,
          appName: parent.appName,
          serverId: parent.serverId,
        },
        db,
      );
      return;
    }

    await this.traefikAppConfig.regenerate(
      {
        applicationId: parent.serviceId,
        appName: parent.appName,
        serverId: parent.serverId,
      },
      db,
    );
  }

  /**
   * Every Domain row of one parent, held to
   * {@link storedDomainRoutingSchema} before any of them is emitted
   * (X05-1).
   *
   * **Why the emitter and not `update`.** `update` is where the finding was
   * reproduced, and it gets its own pre-write call to
   * {@link assertStoredRoutingSafe} so nothing is written and the caller is
   * refused before the transaction opens. But `update` is not where the rule
   * belongs, for two reasons the reproduction does not show:
   *
   * - `TraefikAppConfigService.regenerate` emits **every** Domain of the
   *   Application in one file. A poisoned row is therefore re-emitted by a write
   *   to any *sibling* Domain — creating one, editing one, deleting one — and a
   *   guard that only ever looked at the row named in the URL would watch that
   *   happen. This one re-reads exactly the set the emitter will read.
   * - `remove` reaches the emitter too, and it deletes before it regenerates —
   *   so the poisoned row is already out of this set by the time the guard runs,
   *   and **deleting the row is the remediation** rather than one more refusal.
   *   A guard on the request body could not have offered that.
   *
   * **A refusal, not a silent drop, and not a silent skip.** The three shapes
   * were weighed. Dropping the offending field from the emitted config would
   * quietly un-route a Domain the operator can still see in the console and make
   * the file provider disagree with the database, with nothing to read that
   * says so. Skipping the regeneration silently leaves the previously written
   * injection live and tells nobody — the stored-row failure mode, one layer
   * further in. A 400 naming the field is the only one of the three where the
   * operator learns the row is poisoned; the injected router does stay live
   * until they act, which is worth saying out loud, but it stops being
   * *maintained* the moment this refuses.
   *
   * The refusal is `BadRequestException` rather than a 409 or a 500: the row is
   * the caller's own configuration and correcting it is the caller's to do,
   * which is the same reading `compose.service.ts`'s `getConverted` gives a
   * domain naming a service its file does not declare.
   *
   * **Remediation always gets through, and that is the property to preserve when
   * editing this.** The row under edit is checked by `update` as *merged*, so a
   * PATCH carrying a corrected `path` passes, commits, and then passes here
   * because what this re-reads is the fixed row. Nothing in this guard is
   * allowed to refuse the write that fixes what it is refusing.
   *
   * **One accepted residual, stated so it is not rediscovered as a bug:** a
   * write to a *clean* Domain whose sibling is poisoned answers 400 with its own
   * row already committed, because `create` and `update` reach the emitter after
   * their write. (`remove` no longer does: it reads this set through its own
   * transaction, so its refusal rolls the delete back — #1417.) Hoisting a
   * whole-parent check ahead of every write would close that, and was rejected:
   * it doubles the read on every mutation, it cannot be hoisted for `remove` at
   * all — where the delete *is* the remediation and must run first — and the committed row is itself valid, so what is left is a
   * confusing status code rather than an unsafe one. The message names the
   * sibling, which is what the operator needs either way.
   */
  private async assertParentRowsRoutable(
    parent: ParentService,
    db: DrizzleDB | DrizzleTx = this.db,
  ): Promise<void> {
    const rows = await db.select().from(domain).where(parentColumnIs(parent));
    for (const row of rows) this.assertStoredRoutingSafe(row);
  }

  /**
   * One Domain row's routing values, or a 400 naming the field that is wrong.
   *
   * Named fields only, and the value is never echoed: the message is read by an
   * operator who needs to know *which* box on *which* Domain is poisoned, and
   * repeating a stored injection payload into an error body puts it somewhere
   * new for no gain (§2.5 — a message says what is wrong, not an internal
   * detail).
   *
   * Reached with a row that is not stored yet exactly once — `update`'s merged
   * row. Every issue that can surface there is necessarily a *stored* field,
   * because the global pipe has already held every field the body carried to
   * the same schemas; that is what makes "the stored field is the reason" a
   * safe thing for the message to say at both call sites.
   */
  private assertStoredRoutingSafe(row: {
    domainId: string;
    host: string;
    path: string | null;
    internalPath: string | null;
    customEntrypoint: string | null;
    customCertResolver: string | null;
    middlewares: string[] | null;
  }): void {
    const checked = storedDomainRoutingSchema.safeParse(row);
    if (checked.success) return;

    const fields = checked.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join('; ');
    throw new BadRequestException(
      `Domain ${row.domainId} has a stored value Traefik cannot be given — ${fields}. Correct or delete that Domain; a request that does not carry the field cannot fix it`,
    );
  }

  /**
   * Refuse a Domain aimed at a compose service whose labels are a **map**,
   * at the moment the operator aims it.
   *
   * `addDomainsToComposeSpec` only ever appended Traefik labels to the list
   * form and skipped the map form — silently, while the rest of that function
   * went on joining the service to the routed network and declaring the
   * network external at the root. So the operator got a 201, a Converted tab
   * showing wiring that reads as configured, and no router. This
   * says it here instead, in the same sentence the injector throws
   * ({@link mapFormLabelsRefusal}), so the two cannot drift.
   *
   * **This is a pre-flight, not the authority, and for one source type it is
   * blind.** It reads `composeFile` — the column — so it can only answer for a
   * `raw` stack. A git-sourced stack's compose file lives in the repository:
   * `POST /domains` never reads it (nothing here clones, and the clone on the
   * build server does not exist until the first deploy), which is the same wall
   * H-83's ownership check hit and answered the same way — the guard that
   * *does* see every source type is the one inside the injector, and it is
   * reached by `GET /compose/:id/converted` and by every deploy. Building an
   * SSH `cat` into a domain write to close the gap was rejected: it would make
   * a domain attach depend on the Server being reachable, and it still could
   * not answer before the stack's first deploy.
   *
   * **Deliberately not a refusal of anything else.** An Application parent, a
   * Domain with no `serviceName`, a stack with an empty `composeFile`, a service
   * the file does not declare, YAML that does not parse — all pass here
   * ({@link composeServiceUsesMapFormLabels} fails open on each), because each
   * is either not this rule's business or already some other guard's, and a
   * pre-flight that grew new refusals would be a second rule riding inside this
   * one.
   *
   * **`remove` deliberately gets no check.** Deleting the Domain *is* the
   * remediation for a row already in this state, and nothing in this guard may
   * refuse the write that fixes what it is refusing —
   * {@link assertParentRowsRoutable}'s own rule, applied here.
   *
   * Accepted residual, stated so it is not rediscovered as a bug: **no
   * backfill.** A Domain attached before this rule existed stays in the
   * database. It is not silent any more — the Converted tab answers 400 and the
   * next deploy refuses, both naming the service — but no migration goes
   * looking for it. Same trade the path charset and the claim check took.
   *
   * The residual is narrower now: `PATCH /compose/:id` used to be a second way
   * *into* this state, and this paragraph said so. `ComposeService.update` now
   * runs the same predicate over every Domain row of the stack before it writes,
   * so the only rows left in it are ones that predate that seam or arrived by a
   * direct write to the column.
   */
  private async assertComposeServiceRoutable(
    parent: ParentService,
    host: string,
    serviceName: string | null | undefined,
  ): Promise<void> {
    if (parent.type !== 'compose' || !serviceName) return;

    const definition = await this.findComposeDefinition(parent.serviceId);
    if (definition.sourceType !== 'raw') return;
    if (
      !composeServiceUsesMapFormLabels(
        definition.composeType,
        definition.composeFile,
        serviceName,
      )
    ) {
      return;
    }
    // A 400 rather than a 409: the compose file is the caller's own
    // configuration and rewriting it is the caller's to do — the same reading
    // `assertStoredRoutingSafe` and `getConverted` give a Domain naming a
    // service the file does not declare (§2.5).
    throw new BadRequestException(
      mapFormLabelsRefusal(definition.composeType, host, serviceName),
    );
  }

  /** The Compose stack columns {@link assertComposeServiceRoutable} reads. */
  private async findComposeDefinition(
    composeId: string,
  ): Promise<ComposeDefinition> {
    const [found] = await this.db
      .select({
        sourceType: compose.sourceType,
        composeType: compose.composeType,
        composeFile: compose.composeFile,
      })
      .from(compose)
      .where(eq(compose.composeId, composeId))
      .limit(1);
    // `findParentService` has already resolved this id inside the caller's
    // organization, so a miss here is not reachable — it is answered rather
    // than asserted so the pre-flight can never be the thing that 500s a write.
    if (!found) throw new NotFoundException('Compose not found');
    return found;
  }

  /**
   * The row with its parent's identity, access-scoped. Only the parent's ids
   * and names: its whole row is more columns than Postgres takes as arguments
   * to the `json_build_array` a relational read builds, and nothing a Domain
   * answer needs.
   */
  async findOne(ctx: PermissionCtx, domainId: string) {
    const parentColumns = {
      name: true,
      appName: true,
      environmentId: true,
    } as const;
    const found = await this.db.query.domain.findFirst({
      where: eq(domain.domainId, domainId),
      with: {
        application: { columns: { applicationId: true, ...parentColumns } },
        compose: { columns: { composeId: true, ...parentColumns } },
      },
    });
    if (!found) throw new NotFoundException('Domain not found');

    const parent = await this.findParentService(ctx, found);
    await this.permissions.checkPermission(ctx, { domain: ['read'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    return found;
  }

  /** An Application's domains, access-scoped through the parent. */
  async byApplicationId(ctx: PermissionCtx, applicationId: string) {
    const parent = await this.findParentService(ctx, { applicationId });
    await this.permissions.checkPermission(ctx, { domain: ['read'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');

    const rows = await this.db.query.domain.findMany({
      where: eq(domain.applicationId, applicationId),
    });
    if (isCloud(parent)) {
      const target = await this.pointTargetOf(parent);
      return rows.map((row) => ({
        ...row,
        storedCertificate: null,
        cloud: cloudViewOf(row, target),
      }));
    }
    return withStoredCertificates(
      this.db,
      ctx.session.activeOrganizationId,
      rows,
      () => parent.serverId,
    );
  }

  /**
   * A bucket's Domains, access-scoped through the parent as an
   * Application's are, under the same `domain: read`.
   */
  async byBucketId(ctx: PermissionCtx, bucketId: string) {
    const parent = await this.findParentService(ctx, { bucketId });
    await this.permissions.checkPermission(ctx, { domain: ['read'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');

    const rows = await this.db.query.domain.findMany({
      where: eq(domain.bucketId, bucketId),
    });
    return withStoredCertificates(
      this.db,
      ctx.session.activeOrganizationId,
      rows,
      () => parent.serverId,
    );
  }

  /** A compose stack's domains, access-scoped through the parent. */
  async byComposeId(ctx: PermissionCtx, composeId: string) {
    const parent = await this.findParentService(ctx, { composeId });
    await this.permissions.checkPermission(ctx, { domain: ['read'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');

    const rows = await this.db.query.domain.findMany({
      where: eq(domain.composeId, composeId),
    });
    // A Stack VM's Domains, with their certificate and DNS records (#1371).
    if (isCloud(parent)) {
      const target = await this.pointTargetOf(parent);
      return rows.map((row) => ({
        ...row,
        storedCertificate: null,
        cloud: cloudViewOf(row, target),
      }));
    }
    return withStoredCertificates(
      this.db,
      ctx.session.activeOrganizationId,
      rows,
      () => parent.serverId,
    );
  }

  /**
   * An HTTPS Domain set to `stored` needs a stored certificate that covers its
   * host, or a 400 saying so — refused rather than saved with a warning.
   *
   * Saved, it would get `tls: {}` and Traefik would answer with its own
   * self-signed default, which browsers refuse: the same broken host the
   * operator chose `stored` to avoid, with nothing on screen to explain it. The
   * certificate has to be added first, which is the order Settings →
   * Certificates already asks for.
   *
   * Run on `update`'s merged row, like the checks beside it, so a Domain whose
   * certificate was deleted since is named on its next edit; choosing another
   * certificate is the remediation and always passes. Deleting a certificate
   * is deliberately not refused here — the Domains table says the host is
   * uncovered instead.
   */
  private async assertStoredCertificateCovers(
    ctx: PermissionCtx,
    parent: ParentService,
    row: {
      host: string;
      https?: boolean | null;
      certificateType?: CertificateType | null;
    },
  ): Promise<void> {
    if (!row.https || row.certificateType !== 'stored') return;
    const candidates = await storedCertificatesOn(
      this.db,
      ctx.session.activeOrganizationId,
      parent.serverId,
    );
    if (coveringCertificate(row.host, candidates)) return;
    throw new BadRequestException(
      `No certificate in Settings → Certificates covers ${row.host.trim()} on this ${parent.serverId ? 'Server' : 'platform host'}. Add one whose names include it, or choose another certificate`,
    );
  }

  /**
   * The compose stack's domains shaped for the deploy: label injection for a
   * `docker-compose` Compose, the file-provider config the deploy script
   * writes for a `stack`. Internal — called by the deployment engine's
   * job processor, so no PermissionCtx.
   *
   * **The second emitter, and it is guarded here rather than at its builder
   * (X05-1).** These rows are interpolated raw into
   * ``traefik.http.routers.X.rule=Host(`<host>`) && PathPrefix(`<path>`)``
   * (`compose/compose.utils.ts:82-84`) — the first of the three sinks
   * `pathSchema` names — so a stored row that predates the charsets forges a
   * router on every deploy of its stack, on a path
   * {@link regenerateTraefikConfig} never touches for a `docker-compose`
   * Compose, whose domains get no file-provider config. This is the one seam both consumers pass through
   * (`deployment-engine.service.ts:260`, `compose.service.ts:470`), so the rule
   * is stated once here instead of at each of them.
   *
   * Throwing here is deliberately survivable: the deployment engine calls it
   * **before** the clone's `rm -rf` and reads a throw from this region as "a
   * refused deploy is provably a no-op on the target"
   * (`deployment-engine.service.ts:250-266`), and `getConverted` renders a
   * `BadRequestException` as a 400 like the rest of a stack's own configuration
   * errors.
   */
  async findComposeDomains(composeId: string): Promise<ComposeDomain[]> {
    // A Stack VM's Domains are rules on the cloud's load balancer, never
    // Traefik labels (#1371): {@link findStackVmRoutes} publishes their ports.
    const rows = await this.db
      .select()
      .from(domain)
      .where(
        and(
          eq(domain.composeId, composeId),
          isNull(domain.cloudCertificateStatus),
        ),
      );
    for (const row of rows) this.assertStoredRoutingSafe(row);
    return rows
      .filter((row) => row.serviceName != null)
      .map((row) => ({ ...row, serviceName: row.serviceName as string }));
  }

  /**
   * A Stack VM stack's Domains as its deploy publishes them (#1371): each
   * one's service and port, which `publishStackVmPorts` publishes on the
   * Stack VM for the load balancer. Internal, for the deployment engine.
   */
  async findStackVmRoutes(composeId: string): Promise<StackVmRoute[]> {
    const rows = await this.db
      .select({
        host: domain.host,
        serviceName: domain.serviceName,
        port: domain.port,
      })
      .from(domain)
      .where(
        and(
          eq(domain.composeId, composeId),
          isNotNull(domain.cloudCertificateStatus),
        ),
      )
      .orderBy(asc(domain.createdAt));
    return rows.flatMap((row) =>
      row.serviceName && row.port !== null
        ? [{ host: row.host, serviceName: row.serviceName, port: row.port }]
        : [],
    );
  }

  /**
   * Persists, then regenerates the parent's config.
   *
   * **The merged row is validated, not the body (X05-1).** The global pipe
   * holds every field the body carries, and `updateDomainSchema` is `.partial()`
   * — so a body naming nothing but `port` was validated in full and still
   * committed a row whose stored `path` closes a ``PathPrefix`` argument, then
   * re-emitted it. What has to pass is the row that will exist afterwards, which
   * is why this runs on `withPatchApplied` and runs **before** the transaction:
   * a poisoned row is refused without a write rather than written and then
   * refused at the emitter, so the `port` the caller was told 400 about is
   * genuinely not stored.
   *
   * **This path does not share the cross-tenant exposure, verified rather than assumed.**
   * The `set` below still spreads `data`, and that is safe because
   * `updateDomainSchema` omits both parent ids and, as a plain `z.object`,
   * *strips* them off a body that sends them anyway — so no `applicationId` or
   * `composeId` reaches this method over the wire, and `UpdateDomainDto` gives
   * the compiler the same rule for an internal caller. A Domain therefore cannot
   * be re-pointed at a service that was never access-checked, which is what it
   * would be: every check above reads the row's **current** parent.
   */
  async update(ctx: PermissionCtx, domainId: string, data: UpdateDomainDto) {
    const current = await this.findRow(domainId);
    const parent = await this.findParentService(ctx, current);
    await this.permissions.checkPermission(ctx, { domain: ['create'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    if (isCloud(parent)) {
      return this.updateCloudDomain(ctx, parent, current, data);
    }
    const merged = withPatchApplied(current, data);
    this.assertStoredRoutingSafe(merged);
    if (parent.type === 'bucket') this.assertBucketFields(merged);
    await this.assertForwardAuthMayTurnOn(
      ctx,
      !!current.forwardAuthEnabled,
      data.forwardAuthEnabled,
    );
    // The **merged** row, like the line above it and for the same reason:
    // `updateDomainSchema` is `.partial()`, so a PATCH that renames
    // `serviceName` onto a map-labelled service while carrying nothing else
    // would go unexamined if this read the body. Reading the merged row also
    // means a row attached *before* this check is named the next time an operator
    // edits it, which is the only thing at a write surface that reaches those.
    await this.assertComposeServiceRoutable(
      parent,
      merged.host,
      merged.serviceName,
    );
    await this.assertStoredCertificateCovers(ctx, parent, merged);

    const host = data.host?.trim() ?? current.host;
    const path = data.path ?? current.path;
    const updated = await this.db.transaction(async (tx) => {
      await this.assertRouteUntaken(tx, {
        host,
        path: path ?? '/',
        organizationId: ctx.session.activeOrganizationId,
        exceptDomainId: current.domainId,
      });
      await this.assertHostUnclaimed(tx, {
        host,
        serverId: parent.serverId,
        organizationId: ctx.session.activeOrganizationId,
        exceptDomainId: current.domainId,
      });
      const [row] = await tx
        .update(domain)
        .set({
          ...data,
          ...(data.host && { host }),
          // The merged row's, so a PATCH turning HTTPS off clears the
          // certificate it no longer serves.
          ...(merged.https ? {} : certificateOf(merged)),
        })
        .where(eq(domain.domainId, current.domainId))
        .returning();
      return row;
    });

    await this.regenerateTraefikConfig(parent);
    return updated;
  }

  /**
   * A cloud Domain's edit: the merged row held to the same refusals
   * as an add, a new host a new certificate (its attempt moves on, so the
   * run requests one and removes the old), and its own short Cloud run.
   */
  private async updateCloudDomain(
    ctx: PermissionCtx,
    parent: CloudParent,
    current: Domain,
    data: UpdateDomainDto,
  ) {
    const merged = withPatchApplied(current, data);
    this.assertCloudFields(merged, parent);
    const host = data.host?.trim() ?? current.host;
    const path = data.path ?? current.path ?? '/';
    const cloudFront = onCloudFrontWithPath(parent, path);
    if (parent.type === 'compose') assertStackVmService(merged.serviceName);
    await this.assertCloudRunnable(parent);
    const newHost = host.toLowerCase() !== current.host.toLowerCase();
    const updated = await this.db.transaction(async (tx) => {
      const organizationId = ctx.session.activeOrganizationId;
      if (parent.type === 'compose') {
        await this.assertStackVmPortFree(tx, parent.serviceId, {
          serviceName: merged.serviceName!,
          port: merged.port ?? DEFAULT_DOMAIN_PORT,
          exceptDomainId: current.domainId,
        });
      }
      if (domainsOn(parent).hostAlone) {
        await this.assertHostAlone(tx, {
          host,
          organizationId,
          exceptDomainId: current.domainId,
        });
      }
      await this.assertRouteUntaken(tx, {
        host,
        path,
        organizationId,
        cloud: true,
        exceptDomainId: current.domainId,
      });
      await this.assertHostUnclaimed(tx, {
        host,
        cloud: true,
        organizationId,
        exceptDomainId: current.domainId,
      });
      const [row] = await tx
        .update(domain)
        .set({
          host,
          path,
          ...(data.port === undefined ? {} : { port: data.port }),
          ...(parent.type === 'compose' && data.serviceName !== undefined
            ? { serviceName: data.serviceName }
            : {}),
          ...(newHost ? newCertificate(current) : {}),
        })
        .where(eq(domain.domainId, current.domainId))
        .returning();
      return row;
    });
    const deploymentId = await this.queueCloudRun(parent, {
      title: `Change Domain ${host}`,
      description: runDescriptionOf(parent, 'change', {
        cloudFront,
        host,
        newHost,
        port: updated.port ?? DEFAULT_DOMAIN_PORT,
      }),
    });
    return { ...updated, deploymentId };
  }

  /**
   * **Ask again**: a failed cloud Domain's certificate is requested
   * anew, in its own short Cloud run, and waits for DNS again for 72 hours.
   */
  async askAgain(ctx: PermissionCtx, domainId: string) {
    const current = await this.findRow(domainId);
    const parent = await this.findParentService(ctx, current);
    await this.permissions.checkPermission(ctx, { domain: ['create'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    if (!isCloud(parent) || current.cloudCertificateStatus !== 'failed') {
      throw new BadRequestException(
        'Ask again is for a cloud Domain whose certificate failed',
      );
    }
    const [updated] = await this.db
      .update(domain)
      .set(newCertificate(current))
      .where(eq(domain.domainId, current.domainId))
      .returning();
    const deploymentId = await this.queueCloudRun(parent, {
      title: `Ask again for the certificate of ${current.host}`,
      description: domainsOn(parent).askAgain,
    });
    return { ...updated, deploymentId };
  }

  /**
   * Drops the row and rewrites its Server's file as one change — the writer
   * removes the whole file when no domains remain.
   *
   * **The rewrite runs inside the delete's transaction** (#1417), in
   * ADR-0068's shape: the row is the record of a router on a Server, and a
   * Server that cannot be reached cannot be told to drop it. Deleting first and
   * writing after answered a 500 with the row already gone, so the operator
   * could not tell whether the Domain existed and the file went on routing a
   * host the database no longer had.
   *
   * Now a Server that is not reached is answered as an Application Delete
   * answers one (`traefik/routing-delete.ts`): a 409 naming the Server, and
   * the delete rolled back so the Domain is kept, because the router goes on
   * serving the host while the Service behind it keeps running. `force` is
   * the way out for a Server that is gone for good: the Domain goes, and the
   * answer names the router left in that Server's file (ADR-0018), which the
   * next routing write to that Server rewrites.
   */
  async remove(ctx: PermissionCtx, domainId: string, force = false) {
    const current = await this.findRow(domainId);
    const parent = await this.findParentService(ctx, current);
    await this.permissions.checkPermission(ctx, { domain: ['delete'] });
    await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');
    if (isCloud(parent)) return this.removeCloudDomain(parent, current);

    return this.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(domain)
        .where(eq(domain.domainId, current.domainId))
        .returning();
      const left = await rewriteRoutingForDelete(
        tx,
        {
          appName: parent.appName,
          configName:
            parent.type === 'compose'
              ? composeStackConfigName(parent.appName)
              : parent.appName,
          serverId: parent.serverId,
          noun: 'Domain',
        },
        force,
        () => this.regenerateTraefikConfig(parent, tx),
      );
      return withUnreclaimedArtifacts(removed, left);
    });
  }

  /**
   * A cloud Domain's removal: the row goes, and its own short Cloud
   * run removes its rule and certificate. Cloudgate never wrote its DNS, so
   * the answer names the two records left at the operator's DNS provider.
   */
  private async removeCloudDomain(parent: CloudParent, current: Domain) {
    const target = await this.pointTargetOf(parent);
    const [removed] = await this.db
      .delete(domain)
      .where(eq(domain.domainId, current.domainId))
      .returning();
    const deploymentId = await this.queueCloudRun(parent, {
      title: `Remove Domain ${current.host}`,
      description: runDescriptionOf(parent, 'remove', {
        cloudFront: onCloudFront(parent),
        host: current.host,
        port: current.port ?? DEFAULT_DOMAIN_PORT,
      }),
    });
    const left = recordsLeftBehind(
      current,
      target?.dnsName ?? null,
      target?.kind,
    );
    return {
      ...removed,
      deploymentId,
      dnsRecordsLeft: left,
      message: `Removed from ${cloudNameOf(parent)}. Cloudgate never writes DNS, so remove these records at your DNS provider: ${left.map((record) => `${record.type} ${record.name} → ${record.value}`).join('; ')}`,
    };
  }

  /**
   * A free wildcard-DNS host — sslip.io resolves the embedded IP, so the
   * address of whatever the service runs on rides in the host. Generation
   * only — nothing is persisted.
   *
   * **Where the platform host's address comes from.** This used to read
   * the address off the Server row and nowhere else, so `serverId === null` —
   * "This Cloudgate host", the default for a new Application — took the empty
   * string and minted `<app>-<hash>.sslip.io`: a name with no address in it,
   * which sslip.io answers with nothing. The instance's own public address is
   * recorded on the `web_server_settings` singleton (Settings → Instance), so
   * that is what the platform host uses, dashed by the same two lines the
   * Server case uses rather than a second copy of them.
   * `TemplatesService.resolveServerIp` already reads that column for the same
   * purpose — it is the disagreement between the two that made this a bug
   * rather than a decision, though it still falls back to `127.0.0.1` where
   * this one refuses, which is known as a second site.
   *
   * **No address means no host, rather than a host that cannot resolve.** The
   * old answer was handed straight into the Host field and offered as working,
   * with the dialog's DNS helper then sending the operator after an `A` record
   * in `sslip.io` that nobody but sslip.io can create. A refusal naming the
   * setting is the one thing there is to do about it.
   *
   * The Server branch is deliberately *not* held to the same check: its
   * `ipAddress` is a required column filled when the Server was added, and
   * refusing there would be a new way for an existing fleet to fail.
   */
  async generateDomain(
    ctx: PermissionCtx,
    appName: string,
    serverId?: string | null,
    composeId?: string | null,
  ): Promise<string> {
    await this.permissions.checkPermission(ctx, { domain: ['create'] });
    // A Stack VM has no address an sslip.io name could carry (ADR-0070).
    if (
      composeId &&
      isCloud(await this.findParentService(ctx, { composeId }))
    ) {
      throw new BadRequestException(NO_GENERATED_HOST_ON_STACK_VM);
    }
    return this.generateHostForNewService(ctx, appName, serverId);
  }

  /**
   * {@link generateDomain}'s host for a Service the same operation is
   * creating (a Project config plan's `web`), under that create's own
   * statement rather than `domain: create` (US67), as
   * {@link createForNewService} writes it. The Server is still the caller's.
   */
  async generateHostForNewService(
    ctx: PermissionCtx,
    appName: string,
    serverId?: string | null,
  ): Promise<string> {
    const slugIp = await this.generatedHostAddress(ctx, serverId);
    const hash = randomBytes(3).toString('hex');
    const truncatedAppName = appName.substring(0, 40);
    return `${truncatedAppName}-${hash}${slugIp === '' ? '' : `-${slugIp}`}.sslip.io`;
  }

  /**
   * Whether `host` is one {@link generateHostForNewService} makes for
   * `appName` on this Server (or the platform host): the same name, any
   * hash, the same address. Every other `*.sslip.io` host is one the user
   * typed (#1411), which a Template setup serves over HTTPS. False where
   * no host can be generated at all.
   */
  async isHostGeneratedFor(
    ctx: PermissionCtx,
    host: string,
    appName: string,
    serverId?: string | null,
  ): Promise<boolean> {
    let slugIp: string;
    try {
      slugIp = await this.generatedHostAddress(ctx, serverId);
    } catch (error) {
      if (error instanceof BadRequestException) return false;
      throw error;
    }
    const escape = (text: string) =>
      text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^${escape(appName.substring(0, 40))}-[0-9a-f]{6}${slugIp === '' ? '' : `-${escape(slugIp)}`}\\.sslip\\.io$`,
      'i',
    ).test(host);
  }

  /** The address a generated host carries, dashed as it is written there. */
  private async generatedHostAddress(
    ctx: PermissionCtx,
    serverId?: string | null,
  ): Promise<string> {
    // This was the sixth open-coded copy of the consolidated select, and
    // it is the shape the nine create routes should have had. The
    // helper is byte-identical here: same predicates, same
    // NotFoundException('Server not found'), and `undefined` for the platform
    // host, which is the branch below.
    const found = await checkServerAccess(this.db, ctx, serverId);
    const serverIp = found
      ? found.ipAddress
      : ipLiteral(await this.platformHostIp());
    if (serverIp === null) {
      throw new BadRequestException(NO_PLATFORM_ADDRESS_MESSAGE);
    }
    return serverIp.replaceAll('.', '-').replaceAll(':', '-');
  }

  /**
   * Whether a Service on the platform host can be given a generated host:
   * {@link generateHostForNewService} refuses there while no public address
   * is recorded. A Template setup asks before it offers an Environment
   * (#1375).
   */
  async platformHostGeneratesHosts(): Promise<boolean> {
    return ipLiteral(await this.platformHostIp()) !== null;
  }

  /**
   * The platform host's own public address, or `''` when none is recorded —
   * including on an instance whose settings row does not exist yet.
   *
   * Read off `webServerSettings` directly rather than through
   * `SettingsService`, which would make `DomainsModule` depend on
   * `SettingsModule` for one column: {@link assertHostUnclaimed} two methods
   * down already reads `host` that way and states the reasoning, and the
   * ordering matches `SettingsService.getWebServerSettings` so both resolve the
   * same singleton row.
   */
  private async platformHostIp(): Promise<string> {
    const [settings] = await this.db
      .select({ serverIp: webServerSettings.serverIp })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    return settings?.serverIp ?? '';
  }

  /**
   * Every hostname a pre-built stack asks for, refused before the stack
   * exists.
   *
   * `AiService.deploy` creates a Compose stack, grants access to it and writes
   * every mount before it reaches the domains loop, and none of that is one
   * transaction — so the claim refusal inside {@link create} fired with the
   * stack already in the database and left it there. That was first named as an
   * accepted residual of the `template.toml` deploy (removed in #1364) and is
   * now closed, on the host charset's precedent: a rule that has to run before
   * anything is built is applied at the pre-flight seam too, as `hostSchema`
   * on `deployAiSchema` already does for a hostname's *charset*. A Template's
   * hosts take the same rule through {@link assertHostsUnclaimedInOrganization}
   * (`project-config/applier/taken-template-hosts.ts`), at setup, when its plan is
   * made, and before its Apply writes anything.
   *
   * `serverId` is the deploy's own target rather than a parent's, because there
   * is no parent yet — `createByTemplate` is handed exactly this value a moment
   * later, so the two agree by construction rather than by coincidence.
   *
   * **The caller must have authorized the environment and the Server first**,
   * or this becomes an oracle: "that hostname is claimed" is an answer about
   * another organization's rows. `AiService.deploy` does both
   * (`checkServiceAccess(…, 'create')` and `servers.findOne`) well before it
   * reaches here. Stated as a precondition because nothing in the signature
   * enforces it.
   *
   * The `(host, path)` pair check beside it inside {@link create} has its
   * own pre-flight, {@link assertRoutesUntaken}, which `AiService.deploy`
   * calls first — so no refusal of either rule leaves a stack behind.
   */
  async assertHostsUnclaimed(
    ctx: PermissionCtx,
    hosts: string[],
    serverId: string | null,
  ): Promise<void> {
    await this.assertHostsUnclaimedInOrganization(
      ctx.session.activeOrganizationId,
      hosts,
      serverId,
    );
  }

  /**
   * {@link assertHostsUnclaimed} for a caller that holds an organization id
   * rather than a request context.
   *
   * Added for H-83's compose-label guard, which has to apply this same rule on
   * the **deploy path** — a git-sourced compose file's Traefik labels live in
   * the repository, so no write surface ever sees them and the only seam that
   * does is the deployment engine's, which runs as a queue job with no session
   * at all. Splitting the entry point rather than fabricating a `PermissionCtx`
   * with an empty `user` keeps the thing this rule actually reads — an
   * organization — in the signature, so a later change cannot start reading a
   * `ctx.user` that was never real.
   *
   * **`assertHostsUnclaimed`'s precondition carries over whole and is stricter
   * here, not looser:** the caller must have authorized the target first, or
   * this becomes an oracle — "that hostname is claimed" is an answer about
   * another organization's rows. A queue job's authority is the row it was
   * handed, whose organization it reads off `environment → project`, so the
   * answer never crosses the boundary the ctx-shaped caller's own check drew.
   */
  async assertHostsUnclaimedInOrganization(
    organizationId: string,
    hosts: string[],
    serverId: string | null,
  ): Promise<void> {
    for (const host of hosts) {
      await this.assertHostUnclaimed(this.db, {
        host,
        serverId,
        organizationId,
      });
    }
  }

  /**
   * Every `(host, path)` a pre-built stack asks for, refused before the stack
   * exists — the routing rule {@link create} applies, run at the pre-flight
   * the way {@link assertHostsUnclaimed} runs the claim rule.
   *
   * `AiService.deploy` builds the stack, the grant and every mount before its
   * domains loop reaches `create`, and none of that is one transaction, so a
   * pair refused there used to leave an `idle` stack nobody was told about
   * (first on the `template.toml` deploy, removed in #1364). A Template's
   * Apply asks it of each picked host before any step writes
   * (`project-config/applier/taken-template-hosts.ts`).
   * This applies **the same predicate**, {@link assertRouteUntaken}, with the
   * same normalization `create` applies — the host trimmed, a missing path
   * defaulted to `/` — so it refuses exactly what the late check would and
   * nothing more. The claim check's scope question (may two organizations on different
   * Servers share a host *and* path?) is untouched: the rule stays global,
   * only *when* it runs moved.
   *
   * It also refuses a list naming one pair twice, which no row can show yet:
   * the loop's second insert is what used to find the first. That is the
   * same rule applied to rows about to exist, compared as the column is — the
   * exact strings, as `eq` compares them.
   *
   * Like {@link assertHostsUnclaimed} it reads the pooled `db`, so it
   * shortens the race rather than closing it; the transaction-guarded call
   * inside `create` stays the authority. **Same precondition**: the caller
   * must have authorized the target first, because "this pair is routed" is an
   * answer about rows of any organization.
   *
   * Both callers deploy to a Server, so this is the Server rule: another
   * Organization's cloud Domain does not count (ADR-0060).
   */
  async assertRoutesUntaken(
    ctx: PermissionCtx,
    routes: { host: string; path?: string }[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const route of routes) {
      const host = route.host.trim();
      const path = route.path ?? '/';
      const key = JSON.stringify([host, path]);
      if (seen.has(key)) {
        throw new ConflictException(
          `This deploy names the domain ${host} at path ${path} more than once`,
        );
      }
      seen.add(key);
      await this.assertRouteUntaken(this.db, {
        host,
        path,
        organizationId: ctx.session.activeOrganizationId,
      });
    }
  }

  /**
   * {@link assertRoutesUntaken} and the claim rule for a cloud Domain
   * (ADR-0060): only the Organization's own Domains count, since a cloud
   * Domain is a rule on its own load balancer. A Template's compose Domain
   * in a Cloud Environment is checked by it at setup, plan and Apply
   * (#1379), before the cloud Domain path adds it; that path's own checks
   * stay the authority. Same precondition as the Server rule's.
   */
  async assertCloudRouteUntaken(
    ctx: PermissionCtx,
    route: { host: string; path: string },
  ): Promise<void> {
    const organizationId = ctx.session.activeOrganizationId;
    const host = route.host.trim();
    await this.assertRouteUntaken(this.db, {
      host,
      path: route.path,
      organizationId,
      cloud: true,
    });
    await this.assertHostUnclaimed(this.db, {
      host,
      cloud: true,
      organizationId,
    });
  }

  /**
   * The routing rule: one Domain per exact `(host, path)`, across every
   * organization, because Traefik can hold only one router for it. The one
   * copy of the predicate, for {@link create}, {@link update} (which excludes
   * its own row) and {@link assertRoutesUntaken}.
   *
   * **A cloud Domain is the exception on both sides (ADR-0060).** It reaches no
   * Traefik: its host is a rule on its own Organization's load balancer or
   * distribution, and DNS plus the cloud's certificate decide who serves it.
   * So a `cloud` route is compared only with its own Organization's Domains,
   * and a Server route never with another Organization's cloud Domains (a
   * cloud row is the one with a `cloudCertificateStatus`). Inside one
   * Organization every row counts, as before.
   */
  private async assertRouteUntaken(
    reader: ClaimReader,
    route: {
      host: string;
      path: string;
      organizationId: string;
      cloud?: true;
      exceptDomainId?: string;
    },
  ): Promise<void> {
    const ownRows = heldBy(route.organizationId);
    const [taken] = await reader
      .select({ domainId: domain.domainId })
      .from(domain)
      .where(
        and(
          eq(domain.host, route.host),
          eq(domain.path, route.path),
          route.cloud
            ? ownRows
            : or(isNull(domain.cloudCertificateStatus), ownRows),
          route.exceptDomainId === undefined
            ? undefined
            : ne(domain.domainId, route.exceptDomainId),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ConflictException(
        'Domain with this host and path already exists',
      );
    }
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(domainId: string) {
    const [row] = await this.db
      .select()
      .from(domain)
      .where(eq(domain.domainId, domainId))
      .limit(1);
    if (!row) throw new NotFoundException('Domain not found');
    return row;
  }

  /**
   * Refuse a hostname this organization is not entitled to claim on this
   * Server — the console's own host, or one another organization already holds
   * there.
   *
   * The `(host, path)` pair check above it answers a *routing* question ("is
   * this exact router taken?") and nothing else, so a member could take
   * `(victim.example.com, /api)` while another organization held
   * `(victim.example.com, /)`. Their Application then owns a router for the
   * victim's hostname and prefix on the same Traefik, and requests under that
   * prefix — cookies and bearer headers included — land in a container they
   * control. `hostSchema` validates the *shape* of a hostname
   * (`dto/domain.dto.ts`) and nothing asked who it belonged to.
   *
   * **Why the console host needs a rule of its own, separate from the row
   * lookup below.** The console's router is *not* a Domain row: it is written
   * from `webServerSettings.host` straight into the file provider as
   * `cloudgate-router-app` with ``rule: `Host(`${settings.host}`)` ``
   * (`traefik/config/web-server.ts:124`, `:128`, `:141`). Nothing in the
   * `domain` table describes it, so no query over `domain` can see it and the
   * pair check could not have refused it. Traefik ranks routers by rule
   * **length**, so ``Host(`console.example.com`) && PathPrefix(`/api/auth`)``
   * is strictly longer than the console's bare ``Host(`console.example.com`)``
   * and *wins* for that prefix — an authenticated member redirecting console
   * traffic, the auth routes with it, into their own container. On the platform
   * host that is one file-provider directory shared by the console router and
   * every platform-host Application. We pin `traefik:v3.6.7`
   * (`TRAEFIK_VERSION`, `settings/traefik-setup.service.ts:100`), so that is
   * the ranking in force. The reservation therefore holds for **every**
   * organization including the operator's own, and for every path: the console
   * is not a tenant resource and no prefix under it is available. An unset or
   * empty `host` column reserves nothing — there is no console router to
   * outrank yet.
   *
   * The host is read off `webServerSettings` directly rather than through
   * `SettingsService`, which would make `DomainsModule` depend on
   * `SettingsModule` for one column; `enterprise/sso/sso.service.ts:215` and
   * `monitoring.service.ts:662` are the precedent, and the ordering matches
   * `SettingsService.getWebServerSettings` so both resolve the same singleton
   * row.
   *
   * **Why a claim is per `(serverId, host)` and not global.** Each Server runs
   * its own Traefik and a `null` `serverId` is the platform host (ADR-0008), so
   * a collision only exists between two Domains that reach the same Traefik.
   * Two organizations using one hostname on *different* Servers are not in
   * conflict and must stay allowed. `null` is itself a scope: it matches other
   * `null`s and nothing else.
   *
   * **A cloud Domain claims nothing from another Organization (ADR-0060).** It
   * reaches no Traefik, and with no proof of ownership a shared scope let one
   * customer add another's hostname first and block them from it. DNS and the
   * cloud's own certificate decide who serves it, so a `cloud` claim is
   * refused only the console host, and a cloud Service's Domains, which have
   * no Server either, are not counted in the platform host's scope.
   *
   * The row lookup is `findParentService`'s join run in reverse over both
   * parent kinds — `domain → application|compose → environment →
   * project.organizationId`, taking `serverId` off the parent — extracted here
   * rather than open-coded in `create` and `update` (§1.4; the five drifted
   * copies of `checkServerAccess`, one of which was never written and was the
   * security bug). Comparison is case-insensitive, unlike the pair check's
   * `eq`: DNS and Traefik's `Host` matcher are both case-blind, so an exact
   * match would leave the whole rule one `.toUpperCase()` away from a bypass.
   *
   * **`POST /ai/deploy` and a Template's Apply apply this same check at two
   * seams, and that is the arrangement rather than a duplication.** They
   * reach this one by calling `DomainsService.create` like any other caller —
   * but only after the stack, the RBAC grant and every mount are made, and
   * that is not one transaction, so a refusal here left a half-built stack
   * behind (first on the `template.toml` deploy, removed in #1364). That was
   * once accepted and is now closed. Both also ask the rule at a pre-flight
   * ({@link assertHostsUnclaimed}, or `taken-template-hosts.ts` through
   * {@link assertHostsUnclaimedInOrganization}) before anything exists. That is `hostSchema`'s own arrangement exactly: one
   * rule applied at the extra seam that sees the value early, not a second copy
   * of it. **This transaction-guarded call stays the authority** — the
   * pre-flight reads outside any transaction and cannot be the one that
   * decides, so it shortens the window rather than closing it.
   *
   * Accepted residuals, stated so they are not rediscovered as bugs:
   *
   * - **No backfill.** Rows that already violate this are left alone; the check
   *   governs new writes. An operator who wants the existing ones found gets a
   *   query, not a migration. Same trade the path charset took — **and note what that trade
   *   is not.** This bullet used to read as though a later edit remediated such
   *   a row, which X05-1 disproved: nothing a PATCH does re-runs *this*
   *   check against a claim it does not carry, and a row holding a hostname
   *   another organization owns goes on being re-emitted by every write to its
   *   Application. The charset half of that gap is closed —
   *   {@link assertStoredRoutingSafe} holds the stored `host` to `hostSchema` at
   *   the emitter — but the **ownership** half is not, and cannot be by the same
   *   mechanism: a stored host is well-formed, and deciding it is now claimed
   *   means answering "claimed by whom", which is the query this bullet points
   *   an operator at rather than an oracle {@link HOST_CLAIMED_MESSAGE} exists
   *   to keep shut.
   * - **The same race as the pair check beside it.** This runs in a transaction
   *   with no lock, so two concurrent creates of one hostname can both pass. A
   *   partial unique index cannot express "a *different* organization", so this
   *   keeps parity with its neighbour rather than inventing an advisory lock
   *   for one of the two. Named, not solved.
   * - **The pair check stays global.** It refuses two organizations on
   *   different Servers using the same host *and* path, which by the reasoning
   *   above is a legitimate configuration — so it is too strict. That is a
   *   usability bug, and loosening a refusal must not ride along inside a
   *   security fix. Left for its own issue; the asymmetry is deliberate.
   *
   * Named non-goals: **preview-deployment hosts**, which Phase 25 stores on the
   * `preview_deployment` row rather than a `domain` row
   * (`domain.schema.ts:15-17`) and which are invisible to both checks — the
   * same blind spot the console host had, needing its own pass;
   * **`generateDomain`**, which mints `<app>-<hash>.sslip.io` and is not a
   * squatting surface; and **proving ownership** of a hostname by ACME or a DNS
   * TXT challenge — first-claim-wins per Server is the decision here, real
   * verification is a much larger product change.
   */
  private async assertHostUnclaimed(
    tx: ClaimReader,
    claim: (
      | { serverId: string | null; cloud?: never }
      | { cloud: true; serverId?: never }
    ) & {
      host: string;
      organizationId: string;
      /**
       * `update`'s own row, which is not competing with itself.
       *
       * **No test can turn this red, and that is expected**: the
       * different-organization predicate already excludes every row of the
       * caller's own, this one included, because `findParentService` has
       * already refused a `domainId` whose parent sits outside
       * `activeOrganizationId`. It is passed anyway so the exclusion is stated
       * where `update` can see it rather than inherited from a predicate two
       * lines further down that a later change to the organization rule could
       * quietly remove.
       */
      exceptDomainId?: string;
    },
  ): Promise<void> {
    const wanted = claim.host.trim().toLowerCase();

    const [settings] = await tx
      .select({ host: webServerSettings.host })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    const consoleHost = settings?.host?.trim().toLowerCase() ?? '';
    // The Instance's own hostnames, which `webServerSettings` does not hold:
    // the Hosted instance's one hostname is routed from `dynamic/hosted.yml`,
    // written at install from `CLOUDGATE_HOSTNAME`, and reaches the backend
    // only as its origins (`instance-hosts.ts`). On the Hosted instance each
    // is refused in every scope, so no Organization holds it, or a path under
    // it, anywhere; on a Self-hosted one, where they are the operator's own,
    // in the platform host's scope and a cloud claim's, as the console host is.
    const instanceMode = this.moduleRef.get(InstanceMode, { strict: false });
    const config = this.moduleRef.get(ConfigService, { strict: false });
    const ownHosts = instanceOwnHosts((name) => config.get<string>(name));
    if (
      ownHosts.includes(wanted) &&
      (instanceMode.isHosted || claim.cloud || claim.serverId === null)
    ) {
      throw new ConflictException(HOST_CLAIMED_MESSAGE);
    }
    // `consoleHost !== ''` is the "an unset host reserves nothing" rule stated
    // outright, and **no test can turn it red on its own** — `hostSchema`'s
    // `.min(1)` means `wanted` is never empty, so the comparison below already
    // misses an unset column. It is written anyway because that is a guarantee
    // made in `dto/domain.dto.ts` and applied by a pipe this method never sees,
    // and a reservation that refuses every hostname the moment the column goes
    // empty is the wrong way for this to fail. `an unset console host reserves
    // nothing` pins the behaviour; this clause is what keeps it local.
    if (
      (claim.cloud || claim.serverId === null) &&
      consoleHost !== '' &&
      wanted === consoleHost
    ) {
      throw new ConflictException(HOST_CLAIMED_MESSAGE);
    }
    // A cloud Domain's host is unique per Organization (ADR-0060), and the
    // rows below are only ever another Organization's: past the console
    // host there is nothing for a cloud claim to be refused by. Its own
    // Organization's rows are the route check's and `assertHostAlone`'s.
    if (claim.cloud) return;

    const sameHost = sql`lower(${domain.host}) = ${wanted}`;
    const notThisRow = claim.exceptDomainId
      ? ne(domain.domainId, claim.exceptDomainId)
      : undefined;
    const otherOrganization = ne(project.organizationId, claim.organizationId);

    const [byApplication] = await tx
      .select({ domainId: domain.domainId })
      .from(domain)
      .innerJoin(
        application,
        eq(domain.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          sameHost,
          // A cloud Service has no Server either, but its Domains reach
          // no Traefik, so they hold nothing on the platform host.
          claim.serverId === null
            ? and(
                isNull(application.serverId),
                isNull(application.cloudAccountId),
              )
            : eq(application.serverId, claim.serverId),
          otherOrganization,
          notThisRow,
        ),
      )
      .limit(1);
    if (byApplication) throw new ConflictException(HOST_CLAIMED_MESSAGE);

    const [byCompose] = await tx
      .select({ domainId: domain.domainId })
      .from(domain)
      .innerJoin(compose, eq(domain.composeId, compose.composeId))
      .innerJoin(
        environment,
        eq(compose.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          sameHost,
          claim.serverId === null
            ? isNull(compose.serverId)
            : eq(compose.serverId, claim.serverId),
          otherOrganization,
          notThisRow,
        ),
      )
      .limit(1);
    if (byCompose) throw new ConflictException(HOST_CLAIMED_MESSAGE);

    const [byBucket] = await tx
      .select({ domainId: domain.domainId })
      .from(domain)
      .innerJoin(bucket, eq(domain.bucketId, bucket.bucketId))
      .innerJoin(
        environment,
        eq(bucket.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          sameHost,
          claim.serverId === null
            ? isNull(bucket.serverId)
            : eq(bucket.serverId, claim.serverId),
          otherOrganization,
          notThisRow,
        ),
      )
      .limit(1);
    if (byBucket) throw new ConflictException(HOST_CLAIMED_MESSAGE);
  }

  /**
   * The application or compose row the domain attaches to, org-scoped
   * through environment → project like every service lookup.
   *
   * **Both branches are organization-scoped and always were; what was unsafe is
   * that the first one *returns*.** A `refs` carrying both ids is
   * answered entirely by the `applicationId` branch, so the second id is never
   * looked up, never access-checked, and — once — was still written to
   * its column by `create`'s spread. That is closed at the two places a written
   * id can come from rather than by a third throw here (§2.4): the DTO refuses a
   * create body carrying both, and {@link create} inserts the id this method
   * *resolved*. So the branch order no longer decides anything a caller can
   * exploit, and this stays "resolve the ref you were given" for the five
   * callers that hand it a single ref or a stored row.
   *
   * Accepted residual, stated so it is not rediscovered as a bug: **no
   * backfill.** A `domain` row landed before the fix carries both foreign keys, and
   * for such a row this resolves — and every access decision above it therefore
   * authorizes — the *Application* parent, while the stack it also hangs off
   * goes on receiving its router at deploy time. The remediation is deleting
   * the row, which `remove` allows through, the same trade the earlier Domain
   * rules each took; an operator who wants them found gets the
   * `application_id is not null and compose_id is not null` query, not a
   * migration.
   */
  private async findParentService(
    ctx: PermissionCtx,
    refs: {
      applicationId?: string | null;
      composeId?: string | null;
      bucketId?: string | null;
    },
  ): Promise<ParentService> {
    if (refs.applicationId) {
      const [found] = await this.db
        .select({
          serviceId: application.applicationId,
          appName: application.appName,
          serverId: application.serverId,
          environmentId: application.environmentId,
          cloudAccountId: application.cloudAccountId,
          configKind: application.configKind,
          cloud: cloudAccount.cloud,
        })
        .from(application)
        .innerJoin(
          environment,
          eq(application.environmentId, environment.environmentId),
        )
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, application.cloudAccountId),
        )
        .innerJoin(project, eq(environment.projectId, project.projectId))
        .where(
          and(
            eq(application.applicationId, refs.applicationId),
            eq(project.organizationId, ctx.session.activeOrganizationId),
          ),
        )
        .limit(1);
      if (!found) throw new NotFoundException('Application not found');
      return { ...found, type: 'application' };
    }

    if (refs.composeId) {
      const [found] = await this.db
        .select({
          serviceId: compose.composeId,
          appName: compose.appName,
          serverId: compose.serverId,
          composeType: compose.composeType,
          environmentId: compose.environmentId,
          // A stack on its Stack VM (ADR-0070), whose Domains are the
          // cloud's (#1371).
          cloudAccountId: compose.cloudAccountId,
          cloud: cloudAccount.cloud,
        })
        .from(compose)
        .innerJoin(
          environment,
          eq(compose.environmentId, environment.environmentId),
        )
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, compose.cloudAccountId),
        )
        .innerJoin(project, eq(environment.projectId, project.projectId))
        .where(
          and(
            eq(compose.composeId, refs.composeId),
            eq(project.organizationId, ctx.session.activeOrganizationId),
          ),
        )
        .limit(1);
      if (!found) throw new NotFoundException('Compose not found');
      return { ...found, type: 'compose' };
    }

    if (refs.bucketId) {
      const [found] = await this.db
        .select({
          serviceId: bucket.bucketId,
          appName: bucket.appName,
          serverId: bucket.serverId,
          environmentId: bucket.environmentId,
          // A bucket on AWS, which takes no Domain.
          cloudAccountId: bucket.cloudAccountId,
        })
        .from(bucket)
        .innerJoin(
          environment,
          eq(bucket.environmentId, environment.environmentId),
        )
        .innerJoin(project, eq(environment.projectId, project.projectId))
        .where(
          and(
            eq(bucket.bucketId, refs.bucketId),
            eq(project.organizationId, ctx.session.activeOrganizationId),
          ),
        )
        .limit(1);
      if (!found) throw new NotFoundException('Bucket not found');
      return { ...found, type: 'bucket' };
    }

    throw new BadRequestException(
      'applicationId, composeId or bucketId is required',
    );
  }
}

/** An Application parent in a Cloud account. */
/** The column a parent's Domains hang off. */
function parentColumnIs(parent: ParentService) {
  switch (parent.type) {
    case 'application':
      return eq(domain.applicationId, parent.serviceId);
    case 'compose':
      return eq(domain.composeId, parent.serviceId);
    case 'bucket':
      return eq(domain.bucketId, parent.serviceId);
  }
}

/**
 * A parent whose Domains are the cloud's: an Application in a Cloud
 * account, or a Compose stack on its Stack VM (#1371).
 */
type CloudParent = ParentService & {
  type: 'application' | 'compose';
  environmentId: string;
  cloudAccountId: string;
};

/**
 * The Domain rows an Organization holds, over all three parent kinds,
 * reached through `environment → project.organizationId` like every lookup.
 * Built as subqueries with no handle, so it reads through whichever one the
 * outer query runs on.
 */
function heldBy(organizationId: string): SQL {
  const subquery = new QueryBuilder();
  const environments = subquery
    .select({ id: environment.environmentId })
    .from(environment)
    .innerJoin(project, eq(environment.projectId, project.projectId))
    .where(eq(project.organizationId, organizationId));
  return or(
    inArray(
      domain.applicationId,
      subquery
        .select({ id: application.applicationId })
        .from(application)
        .where(inArray(application.environmentId, environments)),
    ),
    inArray(
      domain.composeId,
      subquery
        .select({ id: compose.composeId })
        .from(compose)
        .where(inArray(compose.environmentId, environments)),
    ),
    inArray(
      domain.bucketId,
      subquery
        .select({ id: bucket.bucketId })
        .from(bucket)
        .where(inArray(bucket.environmentId, environments)),
    ),
  )!;
}

function isCloud(parent: ParentService): parent is CloudParent {
  return (
    (parent.type === 'application' || parent.type === 'compose') &&
    typeof parent.cloudAccountId === 'string' &&
    typeof parent.environmentId === 'string'
  );
}

/** The port a Domain row takes when none is given (`domain.port`'s default). */
const DEFAULT_DOMAIN_PORT = 3000;

/**
 * A Domain on a Stack VM names the compose service the load balancer
 * reaches, whose port its deploy publishes there.
 */
function assertStackVmService(serviceName: string | null | undefined): void {
  if (!serviceName?.trim()) {
    throw new BadRequestException(
      'serviceName: a Domain on a Stack VM names the compose service it reaches',
    );
  }
}

/**
 * What a cloud Domain's short Cloud run does, as its Deployment says it:
 * a stack's on its Stack VM, or a Service's by its cloud.
 */
function runDescriptionOf(
  parent: CloudParent,
  change: 'add' | 'change' | 'remove',
  on: { cloudFront: boolean; host: string; newHost?: boolean; port: number },
): string {
  if (parent.type !== 'compose') {
    return domainsOn(parent).runDescription(change, on);
  }
  const certificate =
    domainsOn(parent).name === 'AWS' ? 'ACM' : 'Google-managed';
  if (change === 'add') {
    return `Requests its ${certificate} certificate and adds its rule on the load balancer, to the Stack VM on port ${on.port}`;
  }
  if (change === 'change') {
    return on.newHost
      ? `Requests a certificate for ${on.host} and moves its rule to it, to the Stack VM on port ${on.port}`
      : `Changes its rule on the load balancer, to the Stack VM on port ${on.port}`;
  }
  return 'Removes its rule and certificate from the load balancer, and closes its port on the Stack VM when no other Domain reaches it';
}

/** A `static` site whose cloud puts its Domain on its distribution. */
function onCloudFront(parent: CloudParent): boolean {
  return (
    parent.configKind === 'static' && domainsOn(parent).staticOnDistribution
  );
}

/** How a cloud Domain lives on one cloud (ADR-0043). */
interface CloudDomains {
  /** The cloud, as a cloud Domain's refusals and answers name it. */
  readonly name: DomainCloudName;
  /** A static site's Domain is its CloudFront distribution's whole host. */
  readonly staticOnDistribution: boolean;
  /** A host takes one Domain: its rule is the network's own. */
  readonly hostAlone: boolean;
  /** What asking again for a failed certificate's Cloud run does. */
  readonly askAgain: string;
  /** What a Domain's Cloud run does, as its Deployment says it. */
  readonly runDescription: (
    change: 'add' | 'change' | 'remove',
    on: { cloudFront: boolean; host: string; newHost?: boolean },
  ) => string;
}

/** Each cloud's {@link CloudDomains}. */
const CLOUD_DOMAINS: PerCloud<CloudDomains> = {
  // A rule on the Environment network's load balancer with its ACM
  // certificate, or a static site's CloudFront distribution.
  aws: {
    name: CLOUD_NAMES.aws,
    staticOnDistribution: true,
    hostAlone: false,
    askAgain: 'Requests a new ACM certificate; the failed one is removed',
    runDescription: awsDomainRunDescription,
  },
  // A host rule on the network's load balancer with its Google-managed
  // certificate, made by a run of the Environment network.
  gcp: {
    name: CLOUD_NAMES.gcp,
    staticOnDistribution: false,
    hostAlone: true,
    askAgain:
      'Requests a new Google-managed certificate; the failed one is removed, and the authorization record stays',
    runDescription: googleDomainRunDescription,
  },
};

/** How a Domain lives on its Service's cloud; one whose cloud is not read, by the seam's rule. */
function domainsOn(parent: CloudParent): CloudDomains {
  return byCloud(cloudOrLegacy(parent.cloud), CLOUD_DOMAINS);
}

/** The cloud, as a cloud Domain's refusals and answers name it. */
function cloudNameOf(parent: CloudParent): DomainCloudName {
  return domainsOn(parent).name;
}

/** A static site on AWS's Domain is its whole host. */
const STATIC_PATH_REFUSAL =
  'path: a Domain on a static site on AWS is its whole host; CloudFront has no rule by path';

/**
 * Whether the Domain goes on a CloudFront distribution, refusing a path
 * other than `/` there ({@link STATIC_PATH_REFUSAL}): an add's and an
 * edit's one check.
 */
function onCloudFrontWithPath(parent: CloudParent, path: string): boolean {
  const cloudFront = onCloudFront(parent);
  if (cloudFront && path !== '/') {
    throw new BadRequestException(STATIC_PATH_REFUSAL);
  }
  // On Google Cloud a static site's host rule is the whole host,
  // rewritten onto its `live/` folder.
  if (parent.configKind === 'static' && path !== '/') {
    throw new BadRequestException(STATIC_PATH_REFUSAL_GOOGLE);
  }
  return cloudFront;
}

/** A static site on Google Cloud's Domain is its whole host. */
const STATIC_PATH_REFUSAL_GOOGLE =
  "path: a Domain on a static site on Google Cloud is its whole host; its one rule serves the site's live folder from /";

/**
 * What a cloud Domain's short Cloud run does, as its Deployment says it:
 * on a static site's CloudFront distribution or a `web`'s load
 * balancer.
 */
function awsDomainRunDescription(
  change: 'add' | 'change' | 'remove',
  on: { cloudFront: boolean; host: string; newHost?: boolean },
): string {
  if (change === 'add') {
    return on.cloudFront
      ? 'Requests its ACM certificate in us-east-1; the host goes on the CloudFront distribution once it is issued'
      : 'Requests its ACM certificate and adds its rule on the load balancer';
  }
  if (change === 'change') {
    if (on.cloudFront) {
      return `Requests a certificate for ${on.host} in us-east-1; the old host comes off the CloudFront distribution, and the new one goes on once it is issued`;
    }
    return on.newHost
      ? `Requests a certificate for ${on.host} and moves its rule to it`
      : 'Changes its rule on the load balancer';
  }
  return on.cloudFront
    ? 'Takes the host off the CloudFront distribution and removes its certificate'
    : 'Removes its rule and certificate from the load balancer';
}

/**
 * What a Domain's Cloud run of the Environment network does on Google Cloud,
 * as its Deployment says it.
 */
function googleDomainRunDescription(
  change: 'add' | 'change' | 'remove',
  on: { host: string; newHost?: boolean },
): string {
  if (change === 'add') {
    return "A run of the Environment network: requests its Google-managed certificate and adds its host rule on the network's load balancer";
  }
  if (change === 'change') {
    return on.newHost
      ? `A run of the Environment network: requests a certificate for ${on.host} and moves its host rule to it`
      : "A run of the Environment network: changes its host rule on the network's load balancer";
  }
  return "A run of the Environment network: removes its host rule, certificate and authorization from the network's load balancer";
}

/**
 * A new certificate for a cloud Domain: the next attempt, waiting for DNS,
 * nothing of the old one kept. The run requests it under its new key.
 */
function newCertificate(current: Domain) {
  return {
    certificateAttempt: current.certificateAttempt + 1,
    cloudCertificateStatus: 'waiting-for-dns' as const,
    acmCertificateArn: null,
    googleCertificateName: null,
    validationRecord: null,
    certificateRequestedAt: null,
    certificateLastPolledAt: null,
    certificateIssuedAt: null,
    certificateFailure: null,
    validationRecordFound: false,
    pointsAtLoadBalancer: false,
  };
}

/**
 * What the console shows of a cloud Domain: its certificate's status,
 * the two records to copy with a tick each, and when a certificate waiting
 * for DNS fails.
 */
function cloudViewOf(row: Domain, target: PointTarget | null) {
  return {
    status: row.cloudCertificateStatus,
    failure: row.certificateFailure,
    requestedAt: row.certificateRequestedAt,
    deadline: row.certificateRequestedAt
      ? certificateDeadline(row.certificateRequestedAt).toISOString()
      : null,
    /** What the host points at, by its DNS name (or a distribution's). */
    loadBalancer: target?.dnsName ?? null,
    servedBy: target?.kind ?? null,
    records: target ? dnsRecordsOf(row, target.dnsName, target.kind) : null,
  };
}
