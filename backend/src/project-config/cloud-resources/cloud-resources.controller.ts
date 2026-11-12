import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { RebuildStateDto } from '../dto/cloud-resources.dto';
import { CloudResources } from './cloud-resources.service';

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
 * A cloud Service's resource list and Rebuild from the cloud. There
 * is no route that reads or downloads a raw Infrastructure state.
 */
@Controller('applications')
export class ServiceCloudResourcesController {
  constructor(private readonly resources: CloudResources) {}

  /** What Cloudgate made for the Service: type, AWS id, region and tags only. */
  @Get(':id/cloud-resources')
  @RequirePermission('service', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.resources.ofService(toCtx(user, session), id);
  }

  /** Discards an unreadable state and plans an adopt by tag; confirmed by the Service's name. */
  @Post(':id/state/rebuild')
  @HttpCode(200)
  @RequirePermission('service', 'update')
  rebuild(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: RebuildStateDto,
  ) {
    return this.resources.rebuildService(
      toCtx(user, session),
      id,
      body.confirmName,
    );
  }
}

/** An Environment network's resource list and Rebuild from the cloud. */
@Controller('environments')
export class NetworkCloudResourcesController {
  constructor(private readonly resources: CloudResources) {}

  /** What Cloudgate made for the network: type, AWS id, region and tags only. */
  @Get(':id/networks/:networkId/resources')
  @RequirePermission('environment', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('networkId') networkId: string,
  ) {
    return this.resources.ofNetwork(toCtx(user, session), id, networkId);
  }

  /** Discards an unreadable state and plans an adopt by tag; confirmed by the Environment's name. */
  @Post(':id/networks/:networkId/state/rebuild')
  @HttpCode(200)
  @RequirePermission('environment', 'update')
  rebuild(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('networkId') networkId: string,
    @Body() body: RebuildStateDto,
  ) {
    return this.resources.rebuildNetwork(
      toCtx(user, session),
      id,
      networkId,
      body.confirmName,
    );
  }
}
