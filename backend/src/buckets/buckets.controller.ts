import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { BucketDeletes } from './bucket-deletes.service';
import { BucketKeyRotation } from './bucket-key-rotation.service';
import { BucketsService } from './buckets.service';
import { PutBucketOriginsDto } from './dto/bucket-origins.dto';
import { CreateExistingBucketDto } from './dto/existing-bucket.dto';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

/**
 * A Bucket's read, its browser-upload origins, its Rotate key
 * and its Delete, with Retry and Forget on AWS. There is no create or update route for
 * the bucket itself: it is made by a plan — but for an existing bucket, which no plan
 * makes — the one record of what a Project runs (ADR-0029); its
 * Delete keeps a Cloudgate-kept config in step as any Service's does.
 * Its origins are Cloudgate's, never the config's, so they are set here.
 */
@Controller('buckets')
export class BucketsController {
  constructor(
    private readonly buckets: BucketsService,
    private readonly deletes: BucketDeletes,
    private readonly rotation: BucketKeyRotation,
  ) {}

  /**
   * "Use an existing bucket" (ADR-0033): the Environment's `bucket`
   * entry stands for an S3 bucket the operator already has, looked up at
   * every plan and never changed. `service: ['create']`, as any create; no
   * new statement. The only create route a bucket has: every other bucket
   * is made by a plan.
   */
  @Post('existing')
  @RequirePermission('service', 'create')
  createExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateExistingBucketDto,
  ) {
    return this.buckets.createExisting(toCtx(user, session), body);
  }

  /**
   * What the "Use an existing bucket" form shows: on Google Cloud
   * the `roles/storage.legacyBucketReader` grant a bucket in another project
   * needs so every plan can look it up; `google: null` on AWS.
   */
  @Get('existing/reach')
  @RequirePermission('service', 'create')
  existingReach(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query('environmentId') environmentId: string,
  ) {
    return this.buckets.existingReach(toCtx(user, session), environmentId);
  }

  /** The bucket's page; an existing bucket on Google Cloud's access is checked again. */
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.buckets.read(toCtx(user, session), id);
  }

  /**
   * The bucket's whole browser-upload origin list, an ordinary
   * Service update.
   */
  @Put(':id/origins')
  @RequirePermission('service', 'update')
  updateOrigins(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: PutBucketOriginsDto,
  ) {
    return this.buckets.updateOrigins(toCtx(user, session), id, body.origins);
  }

  /**
   * Rotate key: a new key, a redeploy of every Service linking the
   * bucket's key, and only then the old key's removal. An ordinary Service
   * update. Answers once the redeploys are queued, with the bucket whose
   * `keyRotation` then follows them to their end.
   */
  @Post(':id/rotate-key')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  rotateKey(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.rotation.rotate(toCtx(user, session), id);
  }

  /**
   * Keeps a bucket that holds files and names it as left behind
   * (`bucketLeftBehind`), and removes an empty one whole.
   * `?deleteFiles=true` — "also delete its files" — empties it first, old
   * versions and delete markers included, and asks for no statement beyond
   * `service: delete`. A string compared to `'true'`, like an Application's
   * `deleteVolumes`.
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('deleteFiles') deleteFiles?: string,
  ) {
    return this.deletes.remove(toCtx(user, session), id, {
      deleteFiles: deleteFiles === 'true',
    });
  }

  /**
   * **Retry** a bucket on AWS's incomplete Delete (ADR-0038): another
   * destroy-only Cloud run from the kept state, emptying it again first if
   * its Delete asked. `service: delete`, as the Delete.
   */
  @Post(':id/delete/retry')
  @HttpCode(200)
  @RequirePermission('service', 'delete')
  retryDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.deletes.retryCloud(toCtx(user, session), id);
  }

  /**
   * **Forget** a bucket on AWS's incomplete Delete (ADR-0038): the row
   * dropped, what is left in AWS written into the audit entry.
   */
  @Post(':id/delete/forget')
  @HttpCode(200)
  @RequirePermission('service', 'delete')
  forgetDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.deletes.forgetCloud(toCtx(user, session), id);
  }
}
