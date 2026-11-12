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
import type { PermissionCtx } from '../rbac/permission.service';
import { AiService } from './ai.service';
import {
  AnalyzeLogsDto,
  CreateAiDto,
  DeployAiDto,
  GetModelsDto,
  SuggestAiDto,
  TestConnectionDto,
  UpdateAiDto,
} from './dto/ai.dto';

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

// Gating: config CRUD is owner/admin only (enforced in
// AiService.ensureOwnerOrAdmin); the rest is open to any organization member.
//
// Two of "the rest" have since left that half, and this is why: `models` and
// `test-connection` take an `apiUrl` out of the body and make the backend fetch
// it, so leaving them open to any member handed every member an SSRF primitive
// aimed from inside the platform host's network. Both are owner/admin now, and
// both check the destination as well as the caller — see
// `AiService.assertDestinationAllowed`.
//
// `suggest` and `analyze-logs` are still open to any member on purpose, and
// their docblocks in the service carry the product reason: a member
// reading a failed build's log is the caller `analyze-logs` exists for, and a
// custom role holding `service: ['create']` is a legitimate caller of
// `suggest`, which is also why `enabled-providers` is member-readable.
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post()
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateAiDto,
  ) {
    return this.aiService.create(toCtx(user, session), body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.aiService.list(toCtx(user, session));
  }

  @Get('enabled-providers')
  getEnabledProviders(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.aiService.getEnabledProviders(toCtx(user, session));
  }

  // POST rather than GET: the caller-supplied apiKey must not travel in a
  // query string.
  @Post('models')
  @HttpCode(200)
  getModels(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: GetModelsDto,
  ) {
    return this.aiService.getModels(toCtx(user, session), body);
  }

  @Post('suggest')
  @HttpCode(200)
  suggest(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: SuggestAiDto,
  ) {
    return this.aiService.suggest(toCtx(user, session), body);
  }

  @Post('analyze-logs')
  @HttpCode(200)
  analyzeLogs(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: AnalyzeLogsDto,
  ) {
    return this.aiService.analyzeLogs(toCtx(user, session), body);
  }

  @Post('test-connection')
  @HttpCode(200)
  testConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestConnectionDto,
  ) {
    return this.aiService.testConnection(toCtx(user, session), body);
  }

  /**
   * The same probe against a config that is already saved. The key
   * comes off the row server-side, because the read path strips it and so the
   * console has nothing to send.
   */
  @Post(':id/test-connection')
  @HttpCode(200)
  testSavedConnection(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.aiService.testSavedConnection(toCtx(user, session), id);
  }

  /**
   * The one `@Post` on this controller besides `create` with no `@HttpCode`
   * it creates a Compose service from the generated template, as
   * `POST /templates/deploy` did until #1364 removed it. Everything else here — `models`, `suggest`,
   * `analyze-logs`, both `test-connection`s — computes an answer and persists
   * nothing, so all of them are `200`.
   */
  @Post('deploy')
  deploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: DeployAiDto,
  ) {
    return this.aiService.deploy(toCtx(user, session), body);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.aiService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateAiDto,
  ) {
    return this.aiService.update(toCtx(user, session), id, body);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.aiService.remove(toCtx(user, session), id);
  }
}
