import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { ApiOkResponse } from '@nestjs/swagger';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { ApplicationsService } from './applications.service';
import {
  ChangeVariablesDto,
  CopyRangeDto,
  CreateApplicationDto,
  SaveApplicationEnvironmentDto,
  TestApplicationRegistryLoginDto,
  UpdateApplicationDto,
  UploadApplicationDropDto,
  VariableListDto,
} from './dto/application.dto';
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
 * The parts of an apply: the file list and the zip of the changed files.
 * Named here so the route's decorators each stay on one line, which is how
 * `route-permissions.spec.ts` reads a handler's decorator block.
 */
const APPLY_DROP_PARTS = FileFieldsInterceptor([
  { name: 'files', maxCount: 1 },
  { name: 'zip', maxCount: 1 },
]);

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateApplicationDto,
  ) {
    return this.applicationsService.create(toCtx(user, session), body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateApplicationDto,
  ) {
    return this.applicationsService.edit(toCtx(user, session), id, body);
  }

  @Patch(':id/environment')
  saveEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveApplicationEnvironmentDto,
  ) {
    return this.applicationsService.saveEnvironment(
      toCtx(user, session),
      id,
      body,
    );
  }

  /**
   * The Application's own runtime variables by name, each with the
   * Output it is wired to. Never a value (ADR 0019): the Cloudgate CLI's
   * `vars list` reads this, never `GET :id`.
   */
  @Get(':id/variables')
  @ApiOkResponse({
    type: VariableListDto,
    description:
      'Every variable name the Application has, with the Output each wired one links to; never a value.',
  })
  listVariables(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.listVariables(toCtx(user, session), id);
  }

  /**
   * Sets and unsets named keys, leaving every other one as it was,
   * and answers the names as the `GET` does. `VARIABLE_IS_LINKED` (409) for
   * a wired name, `VARIABLE_NOT_SET` (404) for unsetting a name not set.
   * Scoped like `PATCH :id/environment`, by the service.
   */
  @Patch(':id/variables')
  @ApiOkResponse({
    type: VariableListDto,
    description:
      'The variable names after the change, as GET answers them; never a value.',
  })
  updateVariables(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: ChangeVariablesDto,
  ) {
    return this.applicationsService.updateVariables(
      toCtx(user, session),
      id,
      body,
    );
  }

  /**
   * Does the registry a Docker-image source pulls from accept this
   * login? `204` when it does, a `400` carrying the registry's own refusal when
   * it does not. No `@RequirePermission`, like the `PATCH` beside it: the
   * service scopes it to whoever may update this Application.
   */
  @Post(':id/test-registry-login')
  @HttpCode(204)
  testRegistryLogin(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: TestApplicationRegistryLoginDto,
  ) {
    return this.applicationsService.testRegistryLogin(
      toCtx(user, session),
      id,
      body,
    );
  }

  /**
   * The upload half of a drop deployment: the zip arrives as the multipart
   * `zip` part and is extracted into the application's code directory.
   * Deploying it stays POST /applications/:id/deployments.
   */
  @Post(':id/drop')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('zip'))
  uploadDrop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @UploadedFile() zip: Express.Multer.File | undefined,
    @Body() body: UploadApplicationDropDto,
  ) {
    if (!zip) {
      throw new BadRequestException('No zip file provided');
    }
    return this.applicationsService.uploadDrop(
      toCtx(user, session),
      id,
      zip.buffer,
      body,
    );
  }

  /**
   * The first half of uploading only the changed files: the multipart
   * `files` part is the folder's file list as JSON, and the answer says which
   * of them the build host is missing (`api-schemas`' `drops.ts`); its
   * `dropBuildPath` field, the apply's, says whether the source is already
   * up to date. Any member
   * who may update the Application may call it; the service scopes it to the
   * caller's organization.
   */
  @Post(':id/drop/compare')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  @UseInterceptors(FileInterceptor('files'))
  compareDrop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @UploadedFile() files: Express.Multer.File | undefined,
    @Body() body: UploadApplicationDropDto,
  ) {
    if (!files) {
      throw new BadRequestException('No file list provided');
    }
    return this.applicationsService.compareDrop(
      toCtx(user, session),
      id,
      files.buffer,
      body,
    );
  }

  /**
   * The second half: the multipart `files` part is the whole folder's file
   * list, the `zip` part only the files compare asked for, and the fields are
   * `/drop`'s. Answers what `/drop` answers. Any member who may update the
   * Application may call it; the service scopes it to the caller's
   * organization.
   */
  @Post(':id/drop/apply')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  @UseInterceptors(APPLY_DROP_PARTS)
  applyDrop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @UploadedFiles()
    parts: { files?: Express.Multer.File[]; zip?: Express.Multer.File[] },
    @Body() body: UploadApplicationDropDto,
  ) {
    const [files] = parts?.files ?? [];
    const [zip] = parts?.zip ?? [];
    if (!files) {
      throw new BadRequestException('No file list provided');
    }
    if (!zip) {
      throw new BadRequestException('No zip file provided');
    }
    return this.applicationsService.applyDrop(
      toCtx(user, session),
      id,
      files.buffer,
      zip.buffer,
      body,
    );
  }

  /**
   * The lifecycle group, decorated exactly like the database
   * controllers' `:id/start` / `:id/stop`: bringing a service up or down is a
   * deployment action, not a config edit.
   */
  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  start(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.start(toCtx(user, session), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  stop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.stop(toCtx(user, session), id);
  }

  /** Restart the Swarm service without rebuilding the image. */
  @Post(':id/reload')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  reload(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.reload(toCtx(user, session), id);
  }

  /**
   * A Cloud Run Service's copy range (spec S10): set on the service by
   * a direct call, then saved. An edit of the Service, `service: ['update']`,
   * with row-level access checked again inside the service.
   */
  @Put(':id/copy-range')
  @RequirePermission('service', 'update')
  setCopyRange(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: CopyRangeDto,
  ) {
    return this.applicationsService.setCopyRange(
      toCtx(user, session),
      id,
      body,
    );
  }

  /**
   * Rotate the secret in the deploy-webhook URL. Undecorated on purpose, like
   * `update` and `saveEnvironment`: it is a service config write, gated by
   * row-level service access inside the service.
   */
  @Post(':id/refresh-token')
  @HttpCode(200)
  refreshToken(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.refreshToken(toCtx(user, session), id);
  }

  /**
   * "Waiting for a GPU" on the Overview: `{ waiting: true, free,
   * cards }` when the Application reserves GPUs and Swarm has left its task
   * pending for want of a node, else `{ waiting: false }`. Read live; writes
   * nothing. Gated by row-level service access in the service, like the read
   * below.
   */
  @Get(':id/gpu-wait')
  gpuWait(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.gpuWait(toCtx(user, session), id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.applicationsService.findOne(toCtx(user, session), id);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good: it
   * drops the row even though Cloudgate could not confirm the swarm service is
   * gone, and the response names what was left behind. Default false, a
   * string query parameter compared to 'true' like compose's `deleteVolumes`.
   *
   * `?deleteVolumes=true` also removes the named volumes of its `volume`
   * mounts on its Server, once the service is confirmed gone; any it
   * keeps — shared with another Service, its Volume lock held, or refused by
   * Docker — is named with the reason in `unreclaimedArtifacts`. Parsed the
   * same way as `force`, and as Compose's.
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('force') force?: string,
    @Query('deleteVolumes') deleteVolumes?: string,
  ) {
    return this.applicationsService.remove(
      toCtx(user, session),
      id,
      force === 'true',
      deleteVolumes === 'true',
    );
  }

  /**
   * **Retry** a cloud Service's incomplete Delete (ADR-0038): another
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
    return this.applicationsService.retryCloudDelete(toCtx(user, session), id);
  }

  /**
   * **Forget** a cloud Service's incomplete Delete (ADR-0038): the row
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
    return this.applicationsService.forgetCloudDelete(toCtx(user, session), id);
  }
}
