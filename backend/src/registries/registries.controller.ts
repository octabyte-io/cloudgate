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
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  CreateRegistryDto,
  TestRegistryConnectionDto,
  TestSavedRegistryConnectionDto,
  UpdateRegistryDto,
} from './dto/registry.dto';
import { RegistriesService } from './registries.service';

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
@Controller('registries')
export class RegistriesController {
  constructor(private readonly registriesService: RegistriesService) {}

  @Post()
  @RequirePermission('registry', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateRegistryDto,
  ) {
    return this.registriesService.create(toCtx(user, session), body);
  }

  /**
   * Does the registry accept this login? `204` when it does, a `400`
   * carrying the registry's own refusal when it does not — and nothing else
   * either way, so no answer can carry the password back out.
   */
  @Post('test-connection')
  @HttpCode(204)
  @RequirePermission('registry', 'create')
  testConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestRegistryConnectionDto,
  ) {
    return this.registriesService.testConnection(toCtx(user, session), body);
  }

  /**
   * The same question for a saved registry, with the stored password —
   * which the console cannot send, because no read ever returns it.
   */
  @Post(':id/test-connection')
  @HttpCode(204)
  @RequirePermission('registry', 'create')
  testSavedConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: TestSavedRegistryConnectionDto,
  ) {
    return this.registriesService.testSavedConnection(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Get()
  @RequirePermission('registry', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.registriesService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('registry', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.registriesService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('registry', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateRegistryDto,
  ) {
    return this.registriesService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  @RequirePermission('registry', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.registriesService.remove(toCtx(user, session), id);
  }
}
