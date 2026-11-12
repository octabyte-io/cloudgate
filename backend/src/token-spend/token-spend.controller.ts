import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { TokenSpendQueryDto } from './dto/token-spend.dto';
import { TokenSpendService } from './token-spend.service';

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

/** Token spend over REST. */
@Controller('applications')
export class TokenSpendController {
  constructor(private readonly tokenSpend: TokenSpendService) {}

  /**
   * An AI model's spend by UTC day over `from`..`to`, split reported and
   * estimated, and by Agent × model served with calls per outcome. Gated by
   * read access to the AI model, in the service; no statement of its own.
   */
  @Get(':id/token-spend')
  forAiModel(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: TokenSpendQueryDto,
  ) {
    return this.tokenSpend.forAiModel(toCtx(user, session), id, query);
  }
}

/** An Environment's Token spend over REST. */
@Controller('environments')
export class EnvironmentTokenSpendController {
  constructor(private readonly tokenSpend: TokenSpendService) {}

  /**
   * The Environment's spend by UTC day over `from`..`to` (default: the last
   * 30 days), and each AI model's total, summing only the AI models the
   * caller can read. Gated by read access to the Environment, in the service.
   */
  @Get(':id/token-spend')
  forEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: TokenSpendQueryDto,
  ) {
    return this.tokenSpend.forEnvironment(toCtx(user, session), id, query);
  }
}

/** A Project's Token spend over REST. */
@Controller('projects')
export class ProjectTokenSpendController {
  constructor(private readonly tokenSpend: TokenSpendService) {}

  /**
   * The Project's spend by UTC day over `from`..`to` (default: the last 30
   * days), and each Environment's total, summing only the AI models the
   * caller can read. Gated by read access to the Project, in the service.
   */
  @Get(':id/token-spend')
  forProject(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: TokenSpendQueryDto,
  ) {
    return this.tokenSpend.forProject(toCtx(user, session), id, query);
  }
}
