import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
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
import {
  SetupEnvironmentsQueryDto,
  TemplateSetupDto,
} from './dto/template-setup.dto';
import { CatalogueQueryDto } from './dto/templates.dto';
import { TemplateSetups } from './setup/template-setups.service';
import { TemplatesService } from './templates.service';

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
 * The Template catalogue and Template setup. No route here is an Agent's:
 * an Agent's key is refused on every REST route (ADR-0023), and no MCP tool
 * reaches setup, since a Pending setup holds secrets.
 */
@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly setups: TemplateSetups,
  ) {}

  /**
   * The Template catalogue as this instance offers it, and the saved copy it
   * came from.
   *
   * **No `baseUrl` query parameter.** It once named the host the backend
   * fetched from, unconstrained, which made an authenticated `GET /templates`
   * a caller-directed fetch out of the platform host. The catalogue is
   * `CLOUDGATE_TEMPLATES_URL` now, an instance-level decision.
   *
   * The `CatalogueQueryDto` parameter is not read and is not dead: it is what
   * makes the global pipe refuse a request that still carries one, instead of
   * zod stripping the key and the caller reading a 200 as agreement.
   */
  @Get()
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- validated, not read */
  list(@Query() _query: CatalogueQueryDto) {
    return this.templatesService.listTemplates();
  }

  @Get('tags')
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- validated, not read */
  tags(@Query() _query: CatalogueQueryDto) {
    return this.templatesService.getTags();
  }

  /**
   * The setup form: the template's asked values, and each of a Project's
   * Environments with whether it can take the template, and why not. With
   * no `projectId` it is the form for a new Project (#1376), which answers
   * by kind of Deploy target.
   */
  @Get(':templateId/setup')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('templateId') templateId: string,
    @Query() query: SetupEnvironmentsQueryDto,
  ) {
    return this.setups.form(toCtx(user, session), templateId, query.projectId);
  }

  /**
   * Sets a Template up (ADR-0065): writes its Pending setup and Setup record,
   * adds its renamed entries to the config and opens the Plan. Every
   * statement its Apply will ask is asked in the service, before anything is
   * written; `service: create` here is the first of them.
   */
  @Post('setup')
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TemplateSetupDto,
  ) {
    return this.setups.setUp(toCtx(user, session), body);
  }
}
