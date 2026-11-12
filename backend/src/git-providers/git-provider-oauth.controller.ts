import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  GithubInstallQueryDto,
  GithubSetupQueryDto,
  OauthCallbackQueryDto,
  StartGithubManifestDto,
} from './dto/git-provider-oauth.dto';
import { GitProviderOauthService } from './git-provider-oauth.service';
import { OAUTH_CALLBACK_PATH } from './oauth-callback.util';
import type { ConsoleRequestHeaders } from './oauth-callback.util';

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
 * **Connecting a git provider by being sent to it**.
 *
 * A separate controller rather than routes on the four strategy controllers, for
 * a boring reason worth writing down: each of those ends in `@Get(':id')`, and a
 * `@Get('callback')` declared after it is shadowed — the callback would be
 * served as a lookup of a connection called "callback". Three segments deep,
 * nothing here can collide with `GET /git-providers/:id` either.
 *
 * Permissions mirror the strategy controllers: starting a handshake is
 * `gitProviders.create`, since it creates or credentials a connection. The
 * *return* legs are `@Public()` by necessity — a provider redirects a browser to
 * them, and no session cookie is guaranteed to ride along on that redirect. The
 * single-use `state` is what stands in for authentication there.
 */
@Controller(OAUTH_CALLBACK_PATH)
export class GitProviderOauthController {
  constructor(private readonly oauth: GitProviderOauthService) {}

  /**
   * The GitHub App setup page, as data: the manifest document plus the
   * github.com form to POST it to. The POST has to come from the browser —
   * GitHub answers it with a redirect carrying a one-time code.
   *
   * **`200` even though this scaffolds a `gitProvider` row**, and the same
   * for the two `authorize` routes. What the caller asked for and gets back is a
   * place to send the browser; the row is bookkeeping for a flow that has not
   * happened yet and that abandoning leaves incomplete. `201` would announce a
   * connection that is not usable until GitHub redirects back.
   */
  @Post('github/manifest')
  @HttpCode(200)
  @RequirePermission('gitProviders', 'create')
  startGithubManifest(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: StartGithubManifestDto,
    @Headers() headers: ConsoleRequestHeaders,
  ) {
    return this.oauth.startGithubAppManifest(
      toCtx(user, session),
      body,
      headers,
    );
  }

  /**
   * The app-manifest conversion, reached by GitHub's redirect (public). Ends by
   * sending the browser on to install the app it just created.
   */
  @Public()
  @Get('github/setup')
  @Redirect('', 302)
  async githubSetup(@Query() query: GithubSetupQueryDto) {
    const { location } = await this.oauth.completeGithubAppManifest(query);
    return { url: location, statusCode: 302 };
  }

  /** GitHub's post-install redirect (public), carrying the installation id. */
  @Public()
  @Get('github/callback')
  @Redirect('', 302)
  async githubCallback(@Query() query: GithubInstallQueryDto) {
    const { location } = await this.oauth.completeGithubInstallation(query);
    return { url: location, statusCode: 302 };
  }

  /** Where to send the browser to authorize a GitLab OAuth application. */
  @Post('gitlab/:id/authorize')
  @HttpCode(200)
  @RequirePermission('gitProviders', 'create')
  startGitlabAuthorization(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Headers() headers: ConsoleRequestHeaders,
  ) {
    return this.oauth.startAuthorization(
      toCtx(user, session),
      'gitlab',
      id,
      headers,
    );
  }

  /** GitLab's OAuth redirect (public): records the grant on the connection. */
  @Public()
  @Get('gitlab/callback')
  @Redirect('', 302)
  async gitlabCallback(@Query() query: OauthCallbackQueryDto) {
    const { location } = await this.oauth.completeAuthorization(
      'gitlab',
      query,
    );
    return { url: location, statusCode: 302 };
  }

  /** Where to send the browser to authorize a Gitea OAuth application. */
  @Post('gitea/:id/authorize')
  @HttpCode(200)
  @RequirePermission('gitProviders', 'create')
  startGiteaAuthorization(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Headers() headers: ConsoleRequestHeaders,
  ) {
    return this.oauth.startAuthorization(
      toCtx(user, session),
      'gitea',
      id,
      headers,
    );
  }

  /** Gitea's OAuth redirect (public): records the grant on the connection. */
  @Public()
  @Get('gitea/callback')
  @Redirect('', 302)
  async giteaCallback(@Query() query: OauthCallbackQueryDto) {
    const { location } = await this.oauth.completeAuthorization('gitea', query);
    return { url: location, statusCode: 302 };
  }
}
