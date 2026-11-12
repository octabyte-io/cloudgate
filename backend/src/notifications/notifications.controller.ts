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
import { Public } from '../auth/decorators/public.decorator';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  ReceiveServerThresholdDto,
  TestCustomDto,
  TestDiscordDto,
  TestEmailDto,
  TestGotifyDto,
  TestLarkDto,
  TestMattermostDto,
  TestNtfyDto,
  TestPushoverDto,
  TestResendDto,
  TestSlackDto,
  TestTeamsDto,
  TestTelegramDto,
  CreateCustomDto,
  CreateDiscordDto,
  CreateEmailDto,
  CreateGotifyDto,
  CreateLarkDto,
  CreateMattermostDto,
  CreateNtfyDto,
  CreatePushoverDto,
  CreateResendDto,
  CreateSlackDto,
  CreateTeamsDto,
  CreateTelegramDto,
  UpdateCustomDto,
  UpdateDiscordDto,
  UpdateEmailDto,
  UpdateGotifyDto,
  UpdateLarkDto,
  UpdateMattermostDto,
  UpdateNtfyDto,
  UpdatePushoverDto,
  UpdateResendDto,
  UpdateSlackDto,
  UpdateTeamsDto,
  UpdateTelegramDto,
} from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

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

// Permission mapping: read on queries, create on create/test-connection,
// update on updates, delete on remove.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('slack')
  @RequirePermission('notification', 'create')
  createSlack(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateSlackDto,
  ) {
    return this.notificationsService.createSlack(toCtx(user, session), body);
  }

  @Patch('slack/:id')
  @RequirePermission('notification', 'update')
  updateSlack(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateSlackDto,
  ) {
    return this.notificationsService.updateSlack(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('telegram')
  @RequirePermission('notification', 'create')
  createTelegram(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateTelegramDto,
  ) {
    return this.notificationsService.createTelegram(toCtx(user, session), body);
  }

  @Patch('telegram/:id')
  @RequirePermission('notification', 'update')
  updateTelegram(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateTelegramDto,
  ) {
    return this.notificationsService.updateTelegram(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('discord')
  @RequirePermission('notification', 'create')
  createDiscord(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateDiscordDto,
  ) {
    return this.notificationsService.createDiscord(toCtx(user, session), body);
  }

  @Patch('discord/:id')
  @RequirePermission('notification', 'update')
  updateDiscord(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateDiscordDto,
  ) {
    return this.notificationsService.updateDiscord(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('email')
  @RequirePermission('notification', 'create')
  createEmail(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateEmailDto,
  ) {
    return this.notificationsService.createEmail(toCtx(user, session), body);
  }

  @Patch('email/:id')
  @RequirePermission('notification', 'update')
  updateEmail(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateEmailDto,
  ) {
    return this.notificationsService.updateEmail(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('resend')
  @RequirePermission('notification', 'create')
  createResend(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateResendDto,
  ) {
    return this.notificationsService.createResend(toCtx(user, session), body);
  }

  @Patch('resend/:id')
  @RequirePermission('notification', 'update')
  updateResend(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateResendDto,
  ) {
    return this.notificationsService.updateResend(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('gotify')
  @RequirePermission('notification', 'create')
  createGotify(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateGotifyDto,
  ) {
    return this.notificationsService.createGotify(toCtx(user, session), body);
  }

  @Patch('gotify/:id')
  @RequirePermission('notification', 'update')
  updateGotify(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateGotifyDto,
  ) {
    return this.notificationsService.updateGotify(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('ntfy')
  @RequirePermission('notification', 'create')
  createNtfy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateNtfyDto,
  ) {
    return this.notificationsService.createNtfy(toCtx(user, session), body);
  }

  @Patch('ntfy/:id')
  @RequirePermission('notification', 'update')
  updateNtfy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateNtfyDto,
  ) {
    return this.notificationsService.updateNtfy(toCtx(user, session), id, body);
  }

  @Post('mattermost')
  @RequirePermission('notification', 'create')
  createMattermost(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateMattermostDto,
  ) {
    return this.notificationsService.createMattermost(
      toCtx(user, session),
      body,
    );
  }

  @Patch('mattermost/:id')
  @RequirePermission('notification', 'update')
  updateMattermost(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateMattermostDto,
  ) {
    return this.notificationsService.updateMattermost(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('custom')
  @RequirePermission('notification', 'create')
  createCustom(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateCustomDto,
  ) {
    return this.notificationsService.createCustom(toCtx(user, session), body);
  }

  @Patch('custom/:id')
  @RequirePermission('notification', 'update')
  updateCustom(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateCustomDto,
  ) {
    return this.notificationsService.updateCustom(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('lark')
  @RequirePermission('notification', 'create')
  createLark(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateLarkDto,
  ) {
    return this.notificationsService.createLark(toCtx(user, session), body);
  }

  @Patch('lark/:id')
  @RequirePermission('notification', 'update')
  updateLark(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateLarkDto,
  ) {
    return this.notificationsService.updateLark(toCtx(user, session), id, body);
  }

  @Post('pushover')
  @RequirePermission('notification', 'create')
  createPushover(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreatePushoverDto,
  ) {
    return this.notificationsService.createPushover(toCtx(user, session), body);
  }

  @Patch('pushover/:id')
  @RequirePermission('notification', 'update')
  updatePushover(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdatePushoverDto,
  ) {
    return this.notificationsService.updatePushover(
      toCtx(user, session),
      id,
      body,
    );
  }

  @Post('teams')
  @RequirePermission('notification', 'create')
  createTeams(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateTeamsDto,
  ) {
    return this.notificationsService.createTeams(toCtx(user, session), body);
  }

  @Patch('teams/:id')
  @RequirePermission('notification', 'update')
  updateTeams(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateTeamsDto,
  ) {
    return this.notificationsService.updateTeams(
      toCtx(user, session),
      id,
      body,
    );
  }

  // Test-connection probes take the create permission.
  /**
   * **`204` on every `/test` route, `201` on every `create` route above it**.
   * The twelve creates insert a connection row and hand it back; the
   * twelve probes call `sendTest`, which is `Promise<void>` — a delivery failure
   * becomes a 400 and success says nothing. So the file reads as two blocks with
   * two codes, which is the distinction intended rather than an oversight in
   * one of them.
   */
  @Post('slack/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testSlack(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestSlackDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'slack',
      body,
    );
  }

  @Post('telegram/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testTelegram(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestTelegramDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'telegram',
      body,
    );
  }

  @Post('discord/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testDiscord(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestDiscordDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'discord',
      body,
    );
  }

  @Post('email/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testEmail(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestEmailDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'email',
      body,
    );
  }

  @Post('resend/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testResend(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestResendDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'resend',
      body,
    );
  }

  @Post('gotify/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testGotify(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestGotifyDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'gotify',
      body,
    );
  }

  @Post('ntfy/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testNtfy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestNtfyDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'ntfy',
      body,
    );
  }

  @Post('mattermost/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testMattermost(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestMattermostDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'mattermost',
      body,
    );
  }

  @Post('custom/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testCustom(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestCustomDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'custom',
      body,
    );
  }

  @Post('lark/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testLark(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestLarkDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'lark',
      body,
    );
  }

  @Post('pushover/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testPushover(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestPushoverDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'pushover',
      body,
    );
  }

  @Post('teams/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testTeams(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: TestTeamsDto,
  ) {
    return this.notificationsService.sendTest(
      toCtx(user, session),
      'teams',
      body,
    );
  }

  /**
   * The same test, naming the row instead of carrying its
   * credentials. Declared **after** the twelve `<channel>/test` routes, which
   * Nest matches first — so `POST /notifications/slack/test` is still the
   * credential-taking create-case probe and is unaffected.
   *
   * One route for all twelve kinds, because the kind is on the row: the
   * connection's own table and the strategy to push through are both derived
   * from `notificationType`, so nothing about it varies per channel here.
   */
  @Post(':id/test')
  @HttpCode(204)
  @RequirePermission('notification', 'create')
  testSaved(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.notificationsService.sendSavedTest(toCtx(user, session), id);
  }

  // Threshold alerts from a metrics agent, which authenticates by server
  // token, not session.
  /**
   * `204`, unlike the two webhooks in `src/` that chose `@HttpCode(200)`
   * (`github.controller.ts`, `billing-webhook.controller.ts`) — those answer with
   * a body and this one is `Promise<void>`. One rule, not a webhook exemption:
   * the code describes the body, and the senders here only ever read 2xx.
   */
  @Public()
  @Post('receive')
  @HttpCode(204)
  receive(@Body() body: ReceiveServerThresholdDto) {
    return this.notificationsService.receiveServerThreshold(body);
  }

  @Get()
  @RequirePermission('notification', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.notificationsService.list(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('notification', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.notificationsService.findOne(toCtx(user, session), id);
  }

  @Delete(':id')
  @RequirePermission('notification', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.notificationsService.remove(toCtx(user, session), id);
  }
}
