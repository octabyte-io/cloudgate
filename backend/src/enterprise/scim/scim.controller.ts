import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../../auth/auth.config';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { ValidatedRequest } from '../../auth/auth.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { GenerateScimTokenDto } from './dto/scim.dto';
import { ScimService } from './scim.service';

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
 * SCIM provider management. All three routes require an owner/admin, and
 * adding a provider also the paid features (a valid enterprise licence, or
 * Business on the Hosted instance); listing and deleting stay open on any plan.
 * Both enforced in the service.
 *
 * The IdP-facing half of SCIM is not here — it is the plugin's own
 * `/api/auth/scim/v2/*` surface, which authenticates with a provider's bearer
 * token rather than a session (see auth.config.ts).
 */
@Controller('scim')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  @Get('providers')
  listProviders(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.scim.listProviders(toCtx(user, session));
  }

  /**
   * No `@HttpCode`, so `201`: the method is named for the token, but the
   * row it registers is the SCIM provider `GET /scim/providers` lists and
   * `DELETE /scim/providers/:providerId` removes. The token is that new row's
   * credential, handed back once.
   */
  @Post('providers')
  generateToken(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: GenerateScimTokenDto,
  ) {
    return this.scim.generateToken(toCtx(user, session), req.headers, body);
  }

  // The provider id is not validated against `providerIdSchema` here: a
  // malformed id matches no row, so it comes back as the same 404 an unknown
  // one does rather than a 400.
  @Delete('providers/:providerId')
  deleteProvider(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('providerId') providerId: string,
  ) {
    return this.scim.deleteProvider(toCtx(user, session), providerId);
  }
}
