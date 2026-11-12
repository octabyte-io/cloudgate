import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { CloudDatabaseBackupsService } from '../common/cloud-database-backups.service';
import { ExistingReachQueryDto } from '../common/dto/existing-reach.dto';
import {
  ChangeRedisStatusDto,
  CreateExistingRedisDto,
  CreateRedisDto,
  UpdateExistingRedisDto,
  SaveRedisElastiCacheSettingsDto,
  SaveRedisMemorystoreSettingsDto,
  SaveRedisEnvironmentDto,
  SaveRedisExternalPortDto,
  SwitchToExistingRedisDto,
  UpdateRedisDto,
} from './dto/redis.dto';
import { SecretsHidden } from './secrets-hidden';
import { RedisService } from './redis.service';
import { AllowedWhenFrozen } from '../../cloud/billing/allowed-when-frozen.decorator';

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

@Controller('redis')
// A redis on ElastiCache's AUTH token is never answered, only whether one
// is set (ADR-0019), nor a cloud redis's unused password.
@UseInterceptors(SecretsHidden)
export class RedisController {
  constructor(
    private readonly redisService: RedisService,
    private readonly cloudBackupsReader: CloudDatabaseBackupsService,
  ) {}

  /**
   * A redis on ElastiCache's Backups tab: its snapshot retention and
   * snapshots, read live from ElastiCache.
   */
  @Get(':id/cloud-backups')
  @RequirePermission('backup', 'read')
  cloudBackups(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudBackupsReader.read(toCtx(user, session), 'redis', id);
  }

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateRedisDto,
  ) {
    return this.redisService.create(toCtx(user, session), body);
  }

  /**
   * "Use an existing database" for a `redis` (ADR-0033): the
   * Environment's entry stands for an ElastiCache replication group the
   * operator already has. `service: ['create']`, as any create.
   */
  @Post('existing')
  @RequirePermission('service', 'create')
  createExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateExistingRedisDto,
  ) {
    return this.redisService.createExisting(toCtx(user, session), body);
  }

  /**
   * What the "Use an existing database" form shows: where this
   * Environment's Services reach a cache from, to let in.
   */
  @Get('existing/reach')
  @RequirePermission('service', 'create')
  existingReach(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ExistingReachQueryDto,
  ) {
    return this.redisService.existingReach(
      toCtx(user, session),
      query.environmentId,
    );
  }

  /**
   * An Existing cache's replication group id, AUTH token, TLS flag or tick
   * (`service: ['update']`).
   */
  @Patch(':id/existing')
  @RequirePermission('service', 'update')
  updateExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateExistingRedisDto,
  ) {
    return this.redisService.updateExisting(toCtx(user, session), id, body);
  }

  /**
   * A switch between a Cloudgate-made and an existing cache
   * (ADR-0033), asked for on the Service's page: `to-existing` takes what
   * "Use an existing cache" takes, `to-made` nothing. Nothing changes until
   * the next plan's Apply, which removes one Service and adds the other —
   * its destroy confirmed by name, as any. `service: ['update']`.
   */
  @Post(':id/switch/to-existing')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  switchToExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SwitchToExistingRedisDto,
  ) {
    return this.redisService.switchToExisting(toCtx(user, session), id, body);
  }

  @Post(':id/switch/to-made')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  switchToMade(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.switchToMade(toCtx(user, session), id);
  }

  /** Cancels a switch no Apply has made yet. */
  @Delete(':id/switch')
  @RequirePermission('service', 'update')
  cancelSwitch(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.cancelSwitch(toCtx(user, session), id);
  }

  @Post(':id/deploy')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  deploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.deploy(toCtx(user, session), id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateRedisDto,
  ) {
    return this.redisService.present(
      await this.redisService.update(toCtx(user, session), id, body),
    );
  }

  /**
   * Cloudgate's own settings of a redis on ElastiCache: its node type
   * when the entry has no size, the replica and snapshot retention, applied
   * by the next plan's Apply.
   */
  @Patch(':id/elasticache-settings')
  @RequirePermission('service', 'update')
  saveElastiCacheSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveRedisElastiCacheSettingsDto,
  ) {
    return this.redisService.saveElastiCacheSettings(
      toCtx(user, session),
      id,
      body,
    );
  }

  /**
   * Cloudgate's own setting of a redis on Memorystore: high
   * availability, a replica in another zone, applied by the next plan's
   * Apply. Refused for a redis anywhere else.
   */
  @Patch(':id/memorystore-settings')
  @RequirePermission('service', 'update')
  async saveMemorystoreSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveRedisMemorystoreSettingsDto,
  ) {
    return this.redisService.present(
      await this.redisService.saveMemorystoreSettings(
        toCtx(user, session),
        id,
        body,
      ),
    );
  }

  @Patch(':id/environment')
  async saveEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveRedisEnvironmentDto,
  ) {
    return this.redisService.present(
      await this.redisService.saveEnvironment(toCtx(user, session), id, body),
    );
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  changeStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: ChangeRedisStatusDto,
  ) {
    return this.redisService.changeStatus(toCtx(user, session), id, body);
  }

  /**
   * `?force=true` drops the row even though Cloudgate could not confirm the
   * swarm service is gone, and the response names what was left behind.
   * Default false, a string query parameter compared to 'true' like compose's
   * `deleteVolumes`.
   */
  /**
   * Whether `<appName>-data` is on the Server now, for the Delete dialog.
   * Guarded as the Delete is. `present` is `null` when it cannot be
   * known — a multi-node swarm, or a Server that did not answer.
   */
  @Get(':id/volume')
  @RequirePermission('service', 'delete')
  dataVolume(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.dataVolume(toCtx(user, session), id);
  }

  /**
   * In a Cloud account the Delete is a destroy-only Cloud run that
   * keeps a final snapshot; `?deleteData=true` — "also delete its data (no
   * final snapshot)" — skips it, and asks for no statement beyond
   * `service: delete`. On a Server it removes the data volume,
   * `<appName>-data`, once the service is confirmed gone; without it the
   * volume stays (#1413). A string compared to `'true'`, like `force`.
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('service', 'delete')
  async remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('force') force?: string,
    @Query('deleteData') deleteData?: string,
  ) {
    return this.redisService.present(
      await this.redisService.remove(
        toCtx(user, session),
        id,
        force === 'true',
        { deleteData: deleteData === 'true' },
      ),
    );
  }

  /**
   * The final snapshot a Delete pressed now keeps, and about what it costs
   * a month, for the Delete dialog of a database in a Cloud account.
   * Guarded as the Delete is; `null` off a Cloud account.
   */
  @Get(':id/final-snapshot')
  @RequirePermission('service', 'delete')
  finalSnapshot(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.finalSnapshot(toCtx(user, session), id);
  }

  /**
   * **Retry** a cloud database's incomplete Delete (ADR-0038): another
   * destroy-only Cloud run from the kept state. `service: delete`, as the
   * Delete.
   */
  @Post(':id/delete/retry')
  @HttpCode(200)
  @RequirePermission('service', 'delete')
  retryDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.retryCloudDelete(toCtx(user, session), id);
  }

  /**
   * **Forget** a cloud database's incomplete Delete (ADR-0038): the
   * row dropped, what is left in AWS written into the audit entry.
   */
  @Post(':id/delete/forget')
  @HttpCode(200)
  @RequirePermission('service', 'delete')
  forgetDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.forgetCloudDelete(toCtx(user, session), id);
  }

  @Post(':id/external-port')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  saveExternalPort(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveRedisExternalPortDto,
  ) {
    return this.redisService.saveExternalPort(toCtx(user, session), id, body);
  }

  @Post(':id/rebuild')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  rebuild(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.rebuild(toCtx(user, session), id);
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  start(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.start(toCtx(user, session), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  stop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.stop(toCtx(user, session), id);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.redisService.present(
      await this.redisService.findOne(toCtx(user, session), id),
    );
  }
}
