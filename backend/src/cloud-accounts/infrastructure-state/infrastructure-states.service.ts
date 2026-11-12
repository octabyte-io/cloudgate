import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { AWS_CLOUD_PORT } from '../cloud.port';
import { GOOGLE_CLOUD_PORT } from '../google-cloud.port';
import type { GoogleCloudPort } from '../google-cloud.port';
import type {
  AwsCloudPort,
  GoogleCredential,
  GoogleStateResource,
  StateResource,
  TofuCredential,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuFailure,
  TofuFailureReason,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuStateOutcome,
  TofuStateReadRequest,
} from '../cloud.port';
import { infrastructureState, tofuStates } from './infrastructure-state.schema';
import type { InfrastructureState } from './infrastructure-state.schema';
import {
  installedVersions,
  newerStateRefusal,
  PROVIDER_FINDS_BY,
} from './state-versions';
import type { StateProvider } from './state-versions';

/** The failures after which `tofu` may have written the state. */
const MAY_HAVE_WRITTEN = new Set<TofuFailureReason>(['failed', 'interrupted']);

/**
 * What an Infrastructure state belongs to: one cloud Service (a `web`, a
 * postgres on RDS, a mysql on RDS, a bucket on S3, a redis on ElastiCache,
 * or a Compose stack's Stack VM) or one Environment network.
 */
export type StateOwner =
  | { applicationId: string }
  | { environmentNetworkId: string }
  | { postgresId: string }
  | { mysqlId: string }
  | { bucketId: string }
  | { redisId: string }
  | { composeId: string };

/**
 * Cloudgate's side of each Infrastructure state (ADR-0036): its row,
 * and every `tofu` run against it. A Cloud run reaches the port's `plan`,
 * `apply` and `destroy` through here, so that before anything runs:
 *
 * - a state already found unreadable fails at once, naming it (Rebuild from
 *   the cloud is offered);
 * - a state last written by a newer OpenTofu or provider — its own
 *   provider's pin, AWS's or Google's — is refused, naming both and saying
 *   to upgrade Cloudgate;
 *
 * and after it:
 *
 * - a state `tofu` could not read is marked unreadable;
 * - an apply or destroy that finished records the install's versions as the
 *   ones that last wrote the state, which is how an older state is brought
 *   forward. A plan writes nothing. No history is kept.
 */
@Injectable()
export class InfrastructureStatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
  ) {}

  /**
   * A new, empty state for its owner; `tofu` makes its `states` row on the
   * first run. `stateId` is the id a plan already read against, so
   * the Apply's run writes the workspace that plan showed rather
   * than a second one nothing refers to. `provider` is the one its owner's
   * Cloud account's cloud writes it with (the Google Cloud spec): its versions are
   * compared against that provider's pin.
   */
  async create(
    owner: StateOwner,
    stateId?: string,
    provider: StateProvider = 'aws',
  ): Promise<InfrastructureState> {
    const [row] = await this.db
      .insert(infrastructureState)
      .values({
        ...owner,
        ...(stateId === undefined ? {} : { infrastructureStateId: stateId }),
        provider,
      })
      .returning();
    return row;
  }

  /** The state an Environment network owns, if it has one yet. */
  async findForNetwork(
    environmentNetworkId: string,
  ): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(
        eq(infrastructureState.environmentNetworkId, environmentNetworkId),
      );
    return row ?? null;
  }

  /** The state a cloud Service owns, if it has one. */
  async findForApplication(
    applicationId: string,
  ): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.applicationId, applicationId));
    return row ?? null;
  }

  /** The state a postgres on RDS owns, if it has one. */
  async findForPostgres(
    postgresId: string,
  ): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.postgresId, postgresId));
    return row ?? null;
  }

  /** The state a mysql on RDS owns, if it has one. */
  async findForMysql(mysqlId: string): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.mysqlId, mysqlId));
    return row ?? null;
  }

  /** The state a Compose stack's Stack VM is in, if it has one (ADR-0070). */
  async findForCompose(composeId: string): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.composeId, composeId));
    return row ?? null;
  }

  /** The state a bucket on AWS owns, if it has one. */
  async findForBucket(bucketId: string): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.bucketId, bucketId));
    return row ?? null;
  }

  /** The state a redis on ElastiCache owns, if it has one. */
  async findForRedis(redisId: string): Promise<InfrastructureState | null> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.redisId, redisId));
    return row ?? null;
  }

  async findOne(stateId: string): Promise<InfrastructureState> {
    const [row] = await this.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.infrastructureStateId, stateId));
    if (!row) {
      throw new NotFoundException(`Infrastructure state ${stateId} not found`);
    }
    return row;
  }

  async plan(
    request: TofuRunRequest<TofuCredential>,
  ): Promise<TofuPlanOutcome> {
    const refusal = await this.refusal(request.stateId);
    if (refusal) return refusal;
    return this.settle(request.stateId, await this.portPlan(request), false);
  }

  /**
   * A plan against a state that has no row yet: the new Service or
   * Environment network a plan would create. Nothing has written it,
   * so there is no version to refuse and nothing to mark unreadable; the
   * Apply that makes its owner creates the row under the same id.
   *
   * The plan writes nothing, but `workspace select -or-create` made the
   * state's OpenTofu workspace, and a create no Apply follows would leave
   * it with no row of Cloudgate's to remove it: it is dropped again here,
   * while still no row names it. The Apply makes it anew.
   */
  async planFresh(
    request: TofuRunRequest<TofuCredential>,
  ): Promise<TofuPlanOutcome> {
    const outcome = await this.portPlan(request);
    await this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: infrastructureState.infrastructureStateId })
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, request.stateId));
      if (!owned) {
        await tx.delete(tofuStates).where(eq(tofuStates.name, request.stateId));
      }
    });
    return outcome;
  }

  async apply(
    request: TofuApplyRequest<TofuCredential>,
  ): Promise<TofuApplyOutcome> {
    const refusal = await this.refusal(request.stateId);
    if (refusal) return refusal;
    return this.settle(request.stateId, await this.portApply(request), true);
  }

  async destroy(
    request: TofuApplyRequest<TofuCredential>,
  ): Promise<TofuApplyOutcome> {
    const refusal = await this.refusal(request.stateId);
    if (refusal) return refusal;
    return this.settle(
      request.stateId,
      isGoogle(request)
        ? await this.google.destroy(request)
        : await this.cloud.destroy(request as TofuApplyRequest),
      true,
    );
  }

  /**
   * What the state holds, through its own cloud's port and projection
   * (Google's): type, AWS id or Google name, region and tags or
   * labels only. Refused like a run when the state is already unreadable or
   * newer than the install, and a state `tofu` cannot read is marked
   * unreadable, as a run marks it. A read writes nothing, so no version is
   * recorded.
   */
  async resources(request: TofuStateReadRequest): Promise<TofuStateOutcome>;
  async resources(
    request: TofuStateReadRequest<GoogleCredential>,
  ): Promise<TofuStateOutcome<GoogleStateResource>>;
  async resources(
    request: TofuStateReadRequest<TofuCredential>,
  ): Promise<TofuStateOutcome<StateResource | GoogleStateResource>> {
    const refusal = await this.refusal(request.stateId);
    if (refusal) return refusal;
    return this.settle(
      request.stateId,
      isGoogle(request)
        ? await this.google.stateResources(request)
        : await this.cloud.stateResources(request as TofuStateReadRequest),
      false,
    );
  }

  /**
   * **Rebuild from the cloud** (ADR-0036): an unreadable state's
   * OpenTofu `states` row is discarded and its record made readable and
   * versionless again, under the same id. Every resource in AWS still
   * carries that id in its `cloudgate:state` tag, so the next plan against
   * the now-empty state adopts by tag what it would otherwise make
   * twice; on Google, where most kinds take no label, by the fixed name
   * every resource of the state is given. A readable
   * state is refused: discarding it would only forget
   * what Cloudgate can still read.
   */
  async discard(stateId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, stateId))
        .for('update');
      if (!row) {
        throw new NotFoundException(
          `Infrastructure state ${stateId} not found`,
        );
      }
      if (row.readable) {
        throw new ConflictException(
          `Cloudgate can read Infrastructure state ${stateId}; Rebuild from the cloud is only for a state it cannot read`,
        );
      }
      await tx.delete(tofuStates).where(eq(tofuStates.name, stateId));
      await tx
        .update(infrastructureState)
        .set({ readable: true, tofuVersion: null, providerVersion: null })
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    });
  }

  /**
   * The state removed, its OpenTofu `states` row and Cloudgate's row
   * together: only once a destroy finished and nothing was left (the AWS spec,
   * "The state is removed only once everything in it is destroyed"). A state
   * a Delete left something in is kept, since it is all that still knows.
   */
  async remove(stateId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(tofuStates).where(eq(tofuStates.name, stateId));
      await tx
        .delete(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    });
  }

  /** A plan through its own cloud's port: the credential says which (the Google Cloud spec). */
  private portPlan(
    request: TofuRunRequest<TofuCredential>,
  ): Promise<TofuPlanOutcome> {
    return isGoogle(request)
      ? this.google.plan(request)
      : this.cloud.plan(request as TofuRunRequest);
  }

  /** An apply through its own cloud's port, as {@link portPlan}. */
  private portApply(
    request: TofuApplyRequest<TofuCredential>,
  ): Promise<TofuApplyOutcome> {
    return isGoogle(request)
      ? this.google.apply(request)
      : this.cloud.apply(request as TofuApplyRequest);
  }

  private async refusal(stateId: string): Promise<TofuFailure | null> {
    const row = await this.findOne(stateId);
    if (!row.readable) {
      return {
        ok: false,
        reason: 'unreadable-state',
        message: `Cloudgate cannot read Infrastructure state ${stateId}. Nothing was changed; Rebuild from the cloud discards it and adopts what Cloudgate's ${PROVIDER_FINDS_BY[row.provider]} find.`,
      };
    }
    const newer = newerStateRefusal(stateId, row);
    return newer ? { ok: false, reason: 'newer-state', message: newer } : null;
  }

  private async settle<
    T extends
      | TofuPlanOutcome
      | TofuApplyOutcome
      | TofuStateOutcome<StateResource | GoogleStateResource>,
  >(stateId: string, outcome: T, writes: boolean): Promise<T> {
    if (!outcome.ok && outcome.reason === 'unreadable-state') {
      await this.db
        .update(infrastructureState)
        .set({ readable: false })
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    } else if (writes && (outcome.ok || MAY_HAVE_WRITTEN.has(outcome.reason))) {
      // A failed or interrupted apply may have saved part of its work, with
      // this install's versions; one that never got the lock wrote nothing.
      const { provider } = await this.findOne(stateId);
      await this.db
        .update(infrastructureState)
        .set(installedVersions(provider))
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    }
    return outcome;
  }
}

function isGoogle<Request extends { credential: TofuCredential }>(
  request: Request,
): request is Request & { credential: GoogleCredential } {
  return 'credentialConfiguration' in request.credential;
}
