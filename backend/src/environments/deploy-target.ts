import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { checkServerAccess } from '../common/owned-server';
import type { DrizzleDB } from '../db/drizzle.module';
import type { InstanceMode } from '../instance-mode/instance-mode.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { server } from '../servers/server.schema';

/**
 * An Environment's **Deploy target** (`CONTEXT.md`): where a
 * Service a plan creates in it will run. A tagged value, so the `cloud` kind a
 * later slice adds is one more member of the union rather than a rewrite
 * of every stored row.
 *
 * It decides only where a Service is *created*. Each Service keeps its own run
 * Server (`serverId` on its row), so changing it moves nothing that runs.
 *
 * `strictObject` for the reason the Project config is strict: a field this does
 * not know is a typo or a newer kind, and either is refused rather than stored
 * and ignored.
 */
export const deployTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('server'),
    serverId: z.string().min(1, 'serverId cannot be empty'),
  }),
  z.strictObject({ kind: z.literal('platform-host') }),
  // A Cloud account plus a region: a `web` a plan creates here runs in
  // that account and region. Added beside the other two, so no stored row is
  // rewritten. Which regions are taken depends on the Cloud account's cloud,
  // so the region is checked once the account is found (`CloudTargetCheck`,
  // spec S17), not here.
  z.strictObject({
    kind: z.literal('cloud'),
    cloudAccountId: z.string().min(1, 'cloudAccountId cannot be empty'),
    region: z.string().min(1, 'region cannot be empty'),
  }),
]);

export type DeployTarget = z.infer<typeof deployTargetSchema>;

/**
 * The Server a Deploy target names, or null: the platform host has no
 * `server` row, and a Cloud account's Services run on no Server.
 */
export function serverIdOf(target: DeployTarget): string | null {
  return target.kind === 'server' ? target.serverId : null;
}

/** The platform host: Cloudgate's own machine, which has no `server` row. */
export const PLATFORM_HOST: DeployTarget = { kind: 'platform-host' };

/**
 * Said when a new Environment names no Deploy target and the organization has
 * a deploy Server, so the platform host is no longer the only place to put
 * one (story 45). With nowhere else to deploy, the platform host is
 * taken without asking.
 */
export const DEPLOY_TARGET_REQUIRED =
  'Choose a Deploy target: this organization has a Server, so a new Environment needs a Server or the platform host chosen';

/**
 * Checks a cloud Deploy target: the Cloud account is the caller's to
 * read, the region is one of its cloud's (spec S17), and the region
 * check passes. `CloudAccountsService.checkDeployTarget`
 * in the app; passed in so this function stays free of the AWS port.
 */
export type CloudTargetCheck = (
  ctx: PermissionCtx,
  given: Extract<DeployTarget, { kind: 'cloud' }>,
) => Promise<{ target: DeployTarget; warnings: string[] }>;

/**
 * The one question the two seams below ask the instance-mode module
 * (ADR-0053): refuse the platform host when this is the Hosted
 * instance. `InstanceMode` in the app; a plain object in a unit spec.
 */
export type PlatformHostRule = Pick<InstanceMode, 'refusePlatformHost'>;

/**
 * Said to a console create in an Environment whose Deploy target is a Cloud
 * account when its body names no Server. Only a plan creates in a
 * Cloud account (ADR-0035), so a console create there runs on a Server or the
 * platform host, and which one is the creator's to say. It used to be the
 * platform host without asking, so a self-hoster whose "prod" pointed at AWS
 * got its Applications on the Cloudgate box.
 */
export const CLOUD_TARGET_NEEDS_SERVER =
  'This Environment deploys to a Cloud account, where only its Project config creates Services. Choose one of your Servers, or this Cloudgate host on purpose.';

/**
 * **The one seam** every console create of a Service asks when its body
 * leaves `serverId` out: in an Environment whose Deploy target is a
 * Cloud account it is refused with {@link CLOUD_TARGET_NEEDS_SERVER}. A body's
 * `null` (the platform host, chosen on purpose) or Server id passes.
 * {@link runServerFor} asks it for an Application; the Compose, template, AI
 * deploy and database creates, which have no Deploy-target fallback, ask it
 * directly, but for a console Compose stack in a cloud Environment, which
 * asks for no Server and runs on its own Stack VM (ADR-0053's amendment,
 * ADR-0070). `test/coding-standards/platform-host-census.spec.ts` holds every
 * Service insert to it.
 *
 * Each caller asks it after `refusePlatformHost`, so the Hosted instance keeps
 * answering with ADR-0053's sentence.
 */
export function refuseUnchosenInCloud(
  given: string | null | undefined,
  target: DeployTarget,
): void {
  if (given === undefined && target.kind === 'cloud') {
    throw new BadRequestException(CLOUD_TARGET_NEEDS_SERVER);
  }
}

/**
 * The run Server a console create lands on when its body names none:
 * the Deploy target's Server, or the platform host (`null`) for a
 * platform-host target. A body that names one — a Server id, or `null` for
 * the platform host — is the creator's choice and is kept.
 *
 * **A Cloud account gives no answer**: a console create never makes a
 * cloud Service, since only a plan creates in a Cloud account (ADR-0035), and
 * the platform host is not assumed in its place, so the create is refused by
 * {@link refuseUnchosenInCloud} until its body names a Server or `null`.
 *
 * **On the Hosted instance there is no such `null`** (ADR-0053 seam 2): a
 * platform-host or Cloud-account target with no Server named is
 * refused with `PLATFORM_HOST_REFUSED`, rather than put on the shared box. A
 * body's own `null` is the creator's choice and is refused where its Server
 * is checked (seam 3), not here.
 */
export function runServerFor(
  given: string | null | undefined,
  target: DeployTarget,
  rule: PlatformHostRule,
): string | null {
  if (given !== undefined) return given;
  if (target.kind === 'server') return target.serverId;
  rule.refusePlatformHost('services');
  refuseUnchosenInCloud(given, target);
  return null;
}

/** A checked Deploy target and what to say beside it. */
export interface ResolvedDeployTarget {
  deployTarget: DeployTarget;
  /** The region check's warnings (a VPC quota nearly reached); empty otherwise. */
  warnings: string[];
}

/**
 * The Deploy target a caller asked for, checked against their organization —
 * or, with none given, the platform host when the organization has no deploy
 * Server and a refusal when it has one.
 *
 * **On the Hosted instance the platform host is never the answer** (ADR-0053
 * seam 1): asking for it, or asking for nothing, is refused with
 * `PLATFORM_HOST_REFUSED`, whatever the organization holds. So an
 * organization with no Server and no Cloud account cannot make an
 * Environment at all, and every Environment there points at one of its own.
 *
 * A named Server goes through `checkServerAccess`, so another organization's
 * Server is refused exactly like an id that names nothing (ADR-0008). A build
 * Server is refused by name: it runs no Service, so it cannot be where one is
 * created. The id stored is the checked row's, not the body's. A Cloud account
 * goes through `checkCloud`.
 */
export async function resolveDeployTarget(
  db: DrizzleDB,
  ctx: PermissionCtx,
  given: DeployTarget | undefined,
  checkCloud: CloudTargetCheck,
  rule: PlatformHostRule,
): Promise<ResolvedDeployTarget> {
  if (given?.kind === 'cloud') {
    const { target, warnings } = await checkCloud(ctx, given);
    return { deployTarget: target, warnings };
  }
  return {
    deployTarget: await resolveOnHost(db, ctx, given, rule),
    warnings: [],
  };
}

async function resolveOnHost(
  db: DrizzleDB,
  ctx: PermissionCtx,
  given: Exclude<DeployTarget, { kind: 'cloud' }> | undefined,
  rule: PlatformHostRule,
): Promise<DeployTarget> {
  if (given === undefined || given.kind === 'platform-host') {
    // No default to the platform host, and no choosing it (seam 1).
    rule.refusePlatformHost('services');
  }
  if (given === undefined) {
    const [deployServer] = await db
      .select({ serverId: server.serverId })
      .from(server)
      .where(
        and(
          eq(server.organizationId, ctx.session.activeOrganizationId),
          eq(server.serverType, 'deploy'),
        ),
      )
      .limit(1);
    if (deployServer) throw new BadRequestException(DEPLOY_TARGET_REQUIRED);
    return PLATFORM_HOST;
  }
  if (given.kind === 'platform-host') return PLATFORM_HOST;

  const found = await checkServerAccess(db, ctx, given.serverId);
  if (!found) throw new NotFoundException('Server not found');
  if (found.serverType !== 'deploy') {
    throw new BadRequestException(
      `Server "${found.name}" is a build Server, so it cannot be a Deploy target`,
    );
  }
  return { kind: 'server', serverId: found.serverId };
}
