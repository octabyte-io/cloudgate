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
  ChangePostgresStatusDto,
  CreateExistingPostgresDto,
  CreatePostgresDto,
  SavePostgresEnvironmentDto,
  SavePostgresExternalPortDto,
  SavePostgresCloudSqlSettingsDto,
  SavePostgresRdsSettingsDto,
  SwitchToExistingPostgresDto,
  UpdateExistingPostgresDto,
  UpdatePostgresDto,
} from './dto/postgres.dto';
import { PostgresService } from './postgres.service';
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

@Controller('postgres')
export class PostgresController {
  constructor(
    private readonly postgresService: PostgresService,
    private readonly cloudBackupsReader: CloudDatabaseBackupsService,
  ) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreatePostgresDto,
  ) {
    return this.postgresService.create(toCtx(user, session), body);
  }

  /**
   * "Use an existing database" (ADR-0033): the Environment's entry
   * stands for an RDS instance the operator already has. `service:
   * ['create']`, as any create; no new statement.
   */
  @Post('existing')
  @RequirePermission('service', 'create')
  createExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateExistingPostgresDto,
  ) {
    return this.postgresService.createExisting(toCtx(user, session), body);
  }

  /**
   * What the "Use an existing database" form shows: where this
   * Environment's Services reach a database from, to let in.
   */
  @Get('existing/reach')
  @RequirePermission('service', 'create')
  existingReach(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ExistingReachQueryDto,
  ) {
    return this.postgresService.existingReach(
      toCtx(user, session),
      query.environmentId,
    );
  }

  /** An Existing database's login, identifier or tick (`service: ['update']`). */
  @Patch(':id/existing')
  @RequirePermission('service', 'update')
  updateExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateExistingPostgresDto,
  ) {
    return this.postgresService.updateExisting(toCtx(user, session), id, body);
  }

  /**
   * A switch between a Cloudgate-made and an existing database
   * (ADR-0033), asked for on the Service's page: `to-existing` takes what
   * "Use an existing database" takes, `to-made` nothing. Nothing changes
   * until the next plan's Apply, which removes one Service and adds the
   * other — its destroy confirmed by name, as any. `service: ['update']`.
   */
  @Post(':id/switch/to-existing')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  switchToExisting(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SwitchToExistingPostgresDto,
  ) {
    return this.postgresService.switchToExisting(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post(':id/switch/to-made')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  switchToMade(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.switchToMade(toCtx(user, session), id);
  }

  /** Cancels a switch no Apply has made yet. */
  @Delete(':id/switch')
  @RequirePermission('service', 'update')
  cancelSwitch(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.cancelSwitch(toCtx(user, session), id);
  }

  @Post(':id/deploy')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  deploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.deploy(toCtx(user, session), id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdatePostgresDto,
  ) {
    return this.postgresService.present(
      await this.postgresService.update(toCtx(user, session), id, body),
    );
  }

  /**
   * Cloudgate's own settings of a postgres on RDS: its class when the
   * entry has no size, storage and its ceiling, Multi-AZ and backup
   * retention, applied by the next plan's Apply.
   */
  @Patch(':id/rds-settings')
  @RequirePermission('service', 'update')
  saveRdsSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SavePostgresRdsSettingsDto,
  ) {
    return this.postgresService.saveRdsSettings(toCtx(user, session), id, body);
  }

  /**
   * Cloudgate's own setting of a postgres on Cloud SQL: its backup
   * retention, 1 to 365 days, edited on its Backups tab and applied by the
   * next plan's Apply. Refused for a postgres anywhere else.
   */
  @Patch(':id/cloud-sql-settings')
  @RequirePermission('service', 'update')
  async saveCloudSqlSettings(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SavePostgresCloudSqlSettingsDto,
  ) {
    return this.postgresService.present(
      await this.postgresService.saveCloudSqlSettings(
        toCtx(user, session),
        id,
        body,
      ),
    );
  }

  /**
   * A postgres in a Cloud account's Backups tab: its
   * retention, the window a restore reaches and its snapshots or backups,
   * read live from RDS or Cloud SQL.
   */
  @Get(':id/cloud-backups')
  @RequirePermission('backup', 'read')
  cloudBackups(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.cloudBackupsReader.read(toCtx(user, session), 'postgres', id);
  }

  @Patch(':id/environment')
  async saveEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SavePostgresEnvironmentDto,
  ) {
    return this.postgresService.present(
      await this.postgresService.saveEnvironment(
        toCtx(user, session),
        id,
        body,
      ),
    );
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  changeStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: ChangePostgresStatusDto,
  ) {
    return this.postgresService.changeStatus(toCtx(user, session), id, body);
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
    return this.postgresService.dataVolume(toCtx(user, session), id);
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
    return this.postgresService.present(
      await this.postgresService.remove(
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
    return this.postgresService.finalSnapshot(toCtx(user, session), id);
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
    return this.postgresService.retryCloudDelete(toCtx(user, session), id);
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
    return this.postgresService.forgetCloudDelete(toCtx(user, session), id);
  }

  @Post(':id/external-port')
  @HttpCode(200)
  @RequirePermission('service', 'create')
  saveExternalPort(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SavePostgresExternalPortDto,
  ) {
    return this.postgresService.saveExternalPort(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post(':id/rebuild')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  rebuild(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.rebuild(toCtx(user, session), id);
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  start(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.start(toCtx(user, session), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  stop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.stop(toCtx(user, session), id);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.postgresService.present(
      await this.postgresService.findOne(toCtx(user, session), id),
    );
  }
}
