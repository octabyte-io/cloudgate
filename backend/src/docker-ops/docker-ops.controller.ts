import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { DockerOpsService } from './docker-ops.service';
import {
  AppNameQueryDto,
  ContainerIdParamsDto,
  ContainersByAppLabelQueryDto,
  ContainersByOwnerLabelQueryDto,
  ServerIdBodyDto,
  ServerIdQueryDto,
  ServiceContainersParamsDto,
  UploadFileBodyDto,
} from './dto/docker-ops.dto';

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

// Permissions: docker:read on the reads, except the by-app-name search which
// rides service:read; the five lifecycle verbs and the file upload
// declare docker:write.
@Controller('docker')
export class DockerOpsController {
  constructor(private readonly dockerOps: DockerOpsService) {}

  @Get('containers')
  @RequirePermission('docker', 'read')
  getContainers(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.dockerOps.getContainers(toCtx(user, session), query);
  }

  @Get('containers/search')
  @RequirePermission('service', 'read')
  getContainersByOwnerLabel(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ContainersByOwnerLabelQueryDto,
  ) {
    return this.dockerOps.getContainersByOwnerLabel(
      toCtx(user, session),
      query,
    );
  }

  @Get('containers/by-label')
  @RequirePermission('docker', 'read')
  getContainersByAppLabel(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ContainersByAppLabelQueryDto,
  ) {
    return this.dockerOps.getContainersByAppLabel(toCtx(user, session), query);
  }

  @Get('containers/stack')
  @RequirePermission('docker', 'read')
  getStackContainersByAppName(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: AppNameQueryDto,
  ) {
    return this.dockerOps.getStackContainersByAppName(
      toCtx(user, session),
      query,
    );
  }

  @Get('containers/service')
  @RequirePermission('docker', 'read')
  getServiceContainersByAppName(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: AppNameQueryDto,
  ) {
    return this.dockerOps.getServiceContainersByAppName(
      toCtx(user, session),
      query,
    );
  }

  /**
   * A Service's running containers, for its Shell tab. **No
   * `@RequirePermission`, deliberately**: the route-level guard would refuse
   * a role lacking `service:update` in better-auth's own sentence, and this
   * route has to answer every refusal — a role without the
   * action, a Service it is not entitled to, a foreign id, an id naming
   * nothing — with the one container denial (ADR-0008). The gate is
   * `ContainerAccessService.authorizeService`, asking `service:update`.
   */
  @Get('services/:serviceType/:serviceId/containers')
  getServiceRunningContainers(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ServiceContainersParamsDto,
  ) {
    return this.dockerOps.getServiceRunningContainers(
      toCtx(user, session),
      params,
    );
  }

  @Get('containers/:containerId/config')
  @RequirePermission('docker', 'read')
  getConfig(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.dockerOps.getConfig(toCtx(user, session), {
      containerId: params.containerId,
      serverId: query.serverId,
    });
  }

  /**
   * **`204` for all four container verbs**. They share
   * `DockerOpsService.containerOp`, which is `Promise<void>`: the daemon's stderr
   * becomes a thrown error and success says nothing. `restart`, `start`, `stop`
   * and `kill` create nothing — the container already exists and is named in the
   * path — so `201` was a plain misreport, and there is no body for a `200`.
   *
   * `containers/:containerId/upload` below is the one exception in this file: it
   * returns `{ success: true }`, so it is `200`. Its status is unchanged; only
   * its permission moved (see below).
   *
   * **And `docker: 'write'` for these four and the `DELETE` below**. The
   * five used to declare `'read'`, which was the only action the resource had —
   * so a licensed custom role granted `docker: ['read']` could `docker rm -f` a
   * managed container while being refused `POST /settings/traefik/reload`. The
   * declaration is kept in step with `containerOp`'s own check rather than left
   * to the service alone: this line is what a reader, and the guard, see first.
   *
   * **And for `containers/:containerId/upload`.** It declared `'read'`
   * too, which the lifecycle fix left, so a licensed custom role holding `docker: ['read']`
   * could `docker cp` a file into any managed container it could address. Both
   * layers said `read` and both moved together, for the same reason as above.
   * `getConfig` and the rest of the reads in this file still declare `'read'`
   * (the by-app-name search rides `service:read`, as it always has) and are
   * unchanged — the upload is the only route that moved.
   */
  @Post('containers/:containerId/restart')
  @HttpCode(204)
  @RequirePermission('docker', 'write')
  restartContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Body() body: ServerIdBodyDto,
  ) {
    return this.dockerOps.restartContainer(toCtx(user, session), {
      containerId: params.containerId,
      serverId: body.serverId,
    });
  }

  @Post('containers/:containerId/start')
  @HttpCode(204)
  @RequirePermission('docker', 'write')
  startContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Body() body: ServerIdBodyDto,
  ) {
    return this.dockerOps.startContainer(toCtx(user, session), {
      containerId: params.containerId,
      serverId: body.serverId,
    });
  }

  @Post('containers/:containerId/stop')
  @HttpCode(204)
  @RequirePermission('docker', 'write')
  stopContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Body() body: ServerIdBodyDto,
  ) {
    return this.dockerOps.stopContainer(toCtx(user, session), {
      containerId: params.containerId,
      serverId: body.serverId,
    });
  }

  @Post('containers/:containerId/kill')
  @HttpCode(204)
  @RequirePermission('docker', 'write')
  killContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Body() body: ServerIdBodyDto,
  ) {
    return this.dockerOps.killContainer(toCtx(user, session), {
      containerId: params.containerId,
      serverId: body.serverId,
    });
  }

  @Delete('containers/:containerId')
  @RequirePermission('docker', 'write')
  removeContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Query() query: ServerIdQueryDto,
  ) {
    return this.dockerOps.removeContainer(toCtx(user, session), {
      containerId: params.containerId,
      serverId: query.serverId,
    });
  }

  @Post('containers/:containerId/upload')
  @HttpCode(200)
  @RequirePermission('docker', 'write')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFileToContainer(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param() params: ContainerIdParamsDto,
    @Body() body: UploadFileBodyDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Invalid file provided');
    }

    await this.dockerOps.uploadFileToContainer(
      toCtx(user, session),
      {
        containerId: params.containerId,
        destinationPath: body.destinationPath,
        serverId: body.serverId || null,
      },
      file.buffer,
      file.originalname,
    );

    return { success: true, message: 'File uploaded successfully' };
  }
}
