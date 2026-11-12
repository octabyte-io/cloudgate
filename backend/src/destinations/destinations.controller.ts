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
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { DestinationsService } from './destinations.service';
import {
  CreateDestinationDto,
  ListDestinationObjectsDto,
  TestConnectionDto,
  TestSavedConnectionDto,
  UpdateDestinationDto,
} from './dto/destination.dto';

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

// Permission mapping: read on queries, create on create/update/test-connection,
// delete on remove.
@Controller('destinations')
export class DestinationsController {
  constructor(private readonly destinationsService: DestinationsService) {}

  @Post()
  @RequirePermission('destination', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateDestinationDto,
  ) {
    return this.destinationsService.create(toCtx(user, session), body);
  }

  /**
   * **`204`, not `200`**. The probe is `Promise<void>` on purpose — its
   * own e2e case asserts `probe.text` is `''`, because nothing coming back is
   * what stops a message carrying the bucket credential back out. A status that
   * announced content would contradict the thing the route is careful about.
   */
  @Post('test-connection')
  @HttpCode(204)
  @RequirePermission('destination', 'create')
  testConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestConnectionDto,
  ) {
    return this.destinationsService.testConnection(toCtx(user, session), body);
  }

  /**
   * The same probe against a destination that is already saved. The
   * credentials come off the row server-side, because the read path strips the
   * secret and so the console has nothing to send.
   */
  @Post(':id/test-connection')
  @HttpCode(204)
  @RequirePermission('destination', 'create')
  testSavedConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: TestSavedConnectionDto,
  ) {
    return this.destinationsService.testSavedConnection(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Get()
  @RequirePermission('destination', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.destinationsService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('destination', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.destinationsService.findOne(toCtx(user, session), id);
  }

  /** What is actually in the bucket, so a restore can pick it. */
  @Get(':id/objects')
  @RequirePermission('destination', 'read')
  listObjects(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: ListDestinationObjectsDto,
  ) {
    return this.destinationsService.listObjects(
      toCtx(user, session),
      id,
      query,
    );
  }

  @Patch(':id')
  @RequirePermission('destination', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateDestinationDto,
  ) {
    return this.destinationsService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('destination', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.destinationsService.remove(toCtx(user, session), id);
  }
}
