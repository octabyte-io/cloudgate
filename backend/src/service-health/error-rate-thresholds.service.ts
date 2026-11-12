import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { eq, inArray, or } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import { findParentService } from '../common/service-parent';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { errorRateThreshold } from '../db/schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import type { PutErrorRateThresholdDto } from './dto/error-rate-threshold.dto';
import { ErrorRateService } from './error-rate.service';
import type { ErrorRateThreshold } from './error-rate-threshold.schema';
import { IncidentsService } from './incidents.service';
import type { Transition } from './incidents.service';
import type { Collection } from './request-metrics-collector.service';
import {
  isThresholdServiceType,
  THRESHOLD_OWNER_COLUMN,
  thresholdOwnerOf,
} from './threshold-owner';
import type { ThresholdServiceType } from './threshold-owner';

/** An Error-rate threshold as the API answers it. */
export interface ErrorRateThresholdView {
  errorRateThresholdId: string;
  serviceType: ThresholdServiceType;
  serviceId: string;
  /** A percent: 5 is 5 %. */
  percentage: number;
  windowMinutes: number;
  minRequests: number;
  enabled: boolean;
  createdAt: string;
}

/** Why a Database is refused one, as the 400 says it. */
export const DATABASE_THRESHOLD_REFUSAL =
  'A Database has no Error rate, so it cannot have an Error-rate threshold';

/**
 * A Service's **Error-rate threshold**: getting, putting and deleting
 * it, and judging every threshold on each request-metrics collection.
 *
 * - **Configured like an Uptime check**: every write is
 *   `service: ['update']` and every read `service: ['read']` on the owning
 *   Service, through `checkServiceAccess` after `findParentService` has
 *   answered another Organization's Service as not found. Every write is
 *   audited by its route (`error-rate-thresholds` in `KIND_BY_SEGMENT`).
 * - **A Database is refused**, since it can never have an Error rate; a
 *   Service whose Error rate is not available yet is not — the threshold
 *   then waits, unjudged, until samples arrive.
 * - **Turning it off closes its open Incident with `turned-off`**, announced
 *   once; any other edit leaves it open for the next judgement. **A Delete
 *   announces nothing**: its Incidents go with it by the cascade.
 */
@Injectable()
export class ErrorRateThresholdsService {
  private readonly logger = new Logger(ErrorRateThresholdsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly incidents: IncidentsService,
    private readonly errorRates: ErrorRateService,
  ) {}

  /** The Service's threshold; 404 when it has none. */
  async get(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<ErrorRateThresholdView> {
    await this.authorize(ctx, serviceType, serviceId, 'read');
    const found = await this.viewOf(serviceType, serviceId);
    if (!found) throw new NotFoundException('No Error-rate threshold');
    return found;
  }

  /**
   * Creates the Service's threshold or replaces its rule, whole. Turning an
   * enabled one off closes its open Incident with `turned-off`.
   */
  async put(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
    data: PutErrorRateThresholdDto,
  ): Promise<ErrorRateThresholdView> {
    await this.authorize(ctx, serviceType, serviceId, 'update');
    if (!isThresholdServiceType(serviceType)) {
      throw new BadRequestException(DATABASE_THRESHOLD_REFUSAL);
    }
    const rule = {
      percentage: data.percentage ?? 5,
      windowMinutes: data.windowMinutes ?? 5,
      minRequests: data.minRequests ?? 20,
      enabled: data.enabled ?? true,
    };
    const owner = THRESHOLD_OWNER_COLUMN[serviceType];

    const { row, transitions } = await this.db.transaction(async (tx) => {
      const lock = () =>
        tx
          .select()
          .from(errorRateThreshold)
          .where(eq(owner, serviceId))
          .for('update');
      let [current] = await lock();
      if (!current) {
        const [created] = await tx
          .insert(errorRateThreshold)
          .values({
            serviceType,
            applicationId: serviceType === 'application' ? serviceId : null,
            composeId: serviceType === 'compose' ? serviceId : null,
            percentage: rule.percentage,
            windowMinutes: rule.windowMinutes,
            minRequests: rule.minRequests,
            enabled: rule.enabled,
          })
          .onConflictDoNothing()
          .returning();
        if (created) return { row: created, transitions: [] };
        // A PUT that raced this one created it first: replace its rule.
        [current] = await lock();
      }
      const [updated] = await tx
        .update(errorRateThreshold)
        .set(rule)
        .where(
          eq(
            errorRateThreshold.errorRateThresholdId,
            current.errorRateThresholdId,
          ),
        )
        .returning();
      const closed: Transition[] =
        current.enabled && !rule.enabled
          ? await this.incidents.closeForThresholds(
              tx,
              [current.errorRateThresholdId],
              'turned-off',
            )
          : [];
      return { row: updated, transitions: closed };
    });
    await this.incidents.announce(transitions);
    return toThresholdView(row);
  }

  /**
   * Deletes the Service's threshold with its Incidents; 404 when it has none.
   * **Announces nothing**, open Incident or not.
   */
  async remove(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<ErrorRateThresholdView> {
    await this.authorize(ctx, serviceType, serviceId, 'update');
    if (!isThresholdServiceType(serviceType)) {
      throw new NotFoundException('No Error-rate threshold');
    }
    const [removed] = await this.db
      .delete(errorRateThreshold)
      .where(eq(THRESHOLD_OWNER_COLUMN[serviceType], serviceId))
      .returning();
    if (!removed) throw new NotFoundException('No Error-rate threshold');
    return toThresholdView(removed);
  }

  /** The Service's threshold as the API answers it, or null; no authorization. */
  async viewOf(
    serviceType: ServiceType,
    serviceId: string,
  ): Promise<ErrorRateThresholdView | null> {
    if (!isThresholdServiceType(serviceType)) return null;
    const [row] = await this.db
      .select()
      .from(errorRateThreshold)
      .where(eq(THRESHOLD_OWNER_COLUMN[serviceType], serviceId))
      .limit(1);
    return row ? toThresholdView(row) : null;
  }

  /**
   * **The judgement**: every enabled threshold of a Service the
   * collection just wrote samples for, over its trailing window ending at the
   * collection's time, on the rate summed over the Service's Domains
   * (`ErrorRateService.windowTotals`). `IncidentsService.judgeThreshold`
   * applies the rule, and skips a Stopped Service — which is still collected,
   * because the 502s Traefik answers for it are real traffic. One threshold
   * failing does not stop the others, and nothing here fails the collection.
   */
  async judge(collection: Collection): Promise<void> {
    let rows: ErrorRateThreshold[];
    try {
      rows = await this.thresholdsOf(collection.owners);
    } catch (error) {
      this.logger.error(
        'Could not read the Error-rate thresholds to judge',
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }
    const at = new Date(collection.collectedAt);
    for (const threshold of rows) {
      if (!threshold.enabled) continue;
      try {
        const window = await this.errorRates.windowTotals(
          thresholdOwnerOf(threshold),
          threshold.windowMinutes * 60_000,
          at.getTime(),
        );
        await this.incidents.judgeThreshold(
          threshold.errorRateThresholdId,
          window,
          at,
        );
      } catch (error) {
        this.logger.error(
          `Could not judge Error-rate threshold ${threshold.errorRateThresholdId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async thresholdsOf(
    owners: Collection['owners'],
  ): Promise<ErrorRateThreshold[]> {
    const applications = owners
      .filter((owner) => owner.serviceType === 'application')
      .map((owner) => owner.serviceId);
    const composes = owners
      .filter((owner) => owner.serviceType === 'compose')
      .map((owner) => owner.serviceId);
    const arms = [
      ...(applications.length > 0
        ? [inArray(errorRateThreshold.applicationId, applications)]
        : []),
      ...(composes.length > 0
        ? [inArray(errorRateThreshold.composeId, composes)]
        : []),
    ];
    if (arms.length === 0) return [];
    return this.db
      .select()
      .from(errorRateThreshold)
      .where(or(...arms));
  }

  /**
   * The owning Service in the caller's Organization, and the caller's right
   * to `action` it — an Uptime check's rule (`UptimeChecksService.authorize`).
   */
  private async authorize(
    ctx: PermissionCtx,
    serviceType: ServiceType,
    serviceId: string,
    action: 'read' | 'update',
  ): Promise<void> {
    await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      serviceId,
      serviceType,
    );
    await this.permissions.checkServiceAccess(ctx, serviceId, action);
  }
}

export function toThresholdView(
  row: ErrorRateThreshold,
): ErrorRateThresholdView {
  const owner = thresholdOwnerOf(row);
  return {
    errorRateThresholdId: row.errorRateThresholdId,
    serviceType: owner.serviceType,
    serviceId: owner.serviceId,
    percentage: row.percentage,
    windowMinutes: row.windowMinutes,
    minRequests: row.minRequests,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}
