import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { gitea, github, gitlab } from '../db/schema';
import type { Gitea, Gitlab } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type {
  GithubInstallQueryDto,
  GithubManifestStartDto,
  GithubSetupQueryDto,
  OauthAuthorizeStartDto,
  OauthCallbackQueryDto,
  StartGithubManifestDto,
} from './dto/git-provider-oauth.dto';
import { FETCH_CLIENT } from './fetch.provider';
import type { FetchClient } from './fetch.provider';
import {
  callbackUrlFor,
  consoleReturnUrl,
  providerFacingBaseOf,
  unprefixedCallbackUrlFor,
} from './oauth-callback.util';
import type { ConsoleRequestHeaders } from './oauth-callback.util';
import { requestOAuthCodeExchange } from './oauth-refresh.util';
import { GitProviderOauthStateService } from './oauth-state.service';
import { GiteaService } from './strategies/gitea/gitea.service';
import {
  buildGithubAppManifest,
  githubAppCreationUrl,
  githubAppInstallUrl,
} from './strategies/github/github-manifest.util';
import { GithubService } from './strategies/github/github.service';
import { GitlabService } from './strategies/gitlab/gitlab.service';

/** The two providers connected by a redirect + `?code=` handshake. */
export type OauthProviderKind = 'gitlab' | 'gitea';

/**
 * What `GitlabService.listRepositories` and `listBranches` need: `api` covers
 * the projects and branches reads, `read_repository` the clone.
 */
const GITLAB_SCOPES = 'api read_user read_repository';

/** Gitea's own default, as `gitea.scopes` stores it. */
const GITEA_DEFAULT_SCOPES = 'repo,repo:status,read:user,read:org';

/** A provider reachable on a private address wins for server-to-server calls. */
const internalFirst = (publicUrl: string, internalUrl: string | null) =>
  (internalUrl || publicUrl).replace(/\/+$/, '');

/** …but a browser redirect must go to the address the browser can reach. */
const publicOnly = (publicUrl: string) => publicUrl.replace(/\/+$/, '');

/**
 * **The routes that produce an OAuth grant**.
 *
 * Before this, every consumer of a grant existed and no producer did:
 * `GithubService.getGithubToken` minted installation tokens from an app id and a
 * private key nobody could obtain without creating the app by hand, and
 * `GitlabService.refreshToken` ran the refresh grant unconditionally whenever
 * `expiresAt` was absent — which nothing recorded — and *threw* when it failed,
 * so a hand-assembled GitLab connection refused every call however valid its
 * access token was.
 *
 * Three handshakes live here, and all three are unauthenticated on the way back
 * because a provider redirects a *browser* to them. The `state` is what makes
 * the return leg believable; see `GitProviderOauthStateService`.
 */
@Injectable()
export class GitProviderOauthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(FETCH_CLIENT) private readonly fetch: FetchClient,
    private readonly states: GitProviderOauthStateService,
    private readonly githubService: GithubService,
    private readonly gitlabService: GitlabService,
    private readonly giteaService: GiteaService,
  ) {}

  // ---------------------------------------------------------------- GitHub App

  /**
   * Leg one of the GitHub App manifest flow: create the connection the
   * app's credentials will land on, and hand the console the manifest plus the
   * github.com form to POST it to.
   *
   * The manifest cannot be POSTed from here — GitHub answers it with a redirect
   * carrying a one-time code, so the *browser* has to make that request. The
   * console renders a self-submitting form.
   */
  async startGithubAppManifest(
    ctx: PermissionCtx,
    body: StartGithubManifestDto,
    headers: ConsoleRequestHeaders,
  ): Promise<GithubManifestStartDto> {
    const base = providerFacingBaseOf(headers);
    const returnTo = consoleReturnUrl(headers);

    const created = await this.githubService.create(ctx, { name: body.name });
    const state = await this.states.issue({
      purpose: 'manifest',
      providerType: 'github',
      gitProviderId: created.gitProviderId,
      returnTo,
    });

    return {
      githubId: created.githubId,
      gitProviderId: created.gitProviderId,
      state: state.state,
      action: githubAppCreationUrl({
        state: state.state,
        organizationName: body.organizationName,
      }),
      manifest: {
        ...buildGithubAppManifest({
          name: body.appName ?? body.name,
          base,
          consoleUrl: returnTo,
        }),
      },
    };
  }

  /**
   * Leg two: GitHub redirected back with a conversion code. `POST
   * /app-manifests/{code}/conversions` is the call that turns one click into an
   * app id, a private key, a client secret and a webhook secret — the four
   * values the paste-them-in flow asked a human to fetch by hand.
   *
   * An app that exists still reaches no repository, so this ends by sending the
   * browser on to install it, under a fresh state.
   */
  async completeGithubAppManifest(
    query: GithubSetupQueryDto,
  ): Promise<{ location: string }> {
    const state = await this.states.consume(query.state, {
      purpose: 'manifest',
      providerType: 'github',
    });

    const response = await this.fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(
        query.code,
      )}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'cloudgate',
        },
      },
    );
    if (!response.ok) {
      throw new BadRequestException(
        `GitHub refused to convert the app manifest: ${response.statusText}`,
      );
    }
    const data = (await response.json()) as {
      id?: number;
      slug?: string;
      client_id?: string;
      client_secret?: string;
      webhook_secret?: string;
      pem?: string;
    };
    // The private key is minted once and never shown again, so a conversion
    // that arrives without one is unrecoverable rather than incomplete.
    if (!data.id || !data.slug || !data.pem) {
      throw new BadRequestException(
        'GitHub’s app-manifest conversion did not include an app id, a slug and a private key',
      );
    }

    await this.db
      .update(github)
      .set({
        appId: data.id,
        appName: data.slug,
        clientId: data.client_id ?? null,
        clientSecret: data.client_secret ?? null,
        webhookSecret: data.webhook_secret ?? null,
        privateKey: data.pem,
      })
      .where(eq(github.gitProviderId, state.gitProviderId));

    const install = await this.states.issue({
      purpose: 'install',
      providerType: 'github',
      gitProviderId: state.gitProviderId,
      returnTo: state.returnTo,
    });
    return {
      location: githubAppInstallUrl({
        slug: data.slug,
        state: install.state,
      }),
    };
  }

  /**
   * Leg three: the app is installed, and GitHub hands back the installation id
   * — the value `GithubService.getGithubToken` and every webhook lookup key off.
   */
  async completeGithubInstallation(
    query: GithubInstallQueryDto,
  ): Promise<{ location: string }> {
    const state = await this.states.consume(query.state, {
      purpose: 'install',
      providerType: 'github',
    });
    await this.db
      .update(github)
      .set({ installationId: query.installation_id })
      .where(eq(github.gitProviderId, state.gitProviderId));
    return { location: `${state.returnTo}?connected=github` };
  }

  // --------------------------------------------------------- GitLab and Gitea

  /**
   * Sends the browser to the provider's own authorize page.
   *
   * The OAuth *application* still has to be registered at the provider by hand
   * — that is inherent — so this starts from a connection that already carries
   * a client id and secret. What it adds is the grant: the callback records an
   * access token, a refresh token **and an `expiresAt`**, which is the value
   * GitLab's refresh path demands and nothing else was ever writing.
   */
  async startAuthorization(
    ctx: PermissionCtx,
    kind: OauthProviderKind,
    connectionId: string,
    headers: ConsoleRequestHeaders,
  ): Promise<OauthAuthorizeStartDto> {
    const base = providerFacingBaseOf(headers);
    const returnTo = consoleReturnUrl(headers);

    if (kind === 'gitlab') {
      const row = await this.gitlabService.findOne(ctx, connectionId);
      if (!row.applicationId) {
        throw new BadRequestException(
          'Save this connection’s GitLab application ID and secret before authorizing it',
        );
      }
      const redirectUri = await this.settleRedirectUri(
        ctx,
        kind,
        connectionId,
        row.redirectUri,
        base,
      );
      const state = await this.states.issue({
        purpose: 'authorize',
        providerType: 'gitlab',
        gitProviderId: row.gitProviderId,
        returnTo,
        redirectUri,
      });
      const query = new URLSearchParams({
        client_id: row.applicationId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state: state.state,
        scope: GITLAB_SCOPES,
      });
      return {
        state: state.state,
        redirectUri,
        url: `${publicOnly(row.gitlabUrl)}/oauth/authorize?${query.toString()}`,
      };
    }

    const row = await this.giteaService.findOne(ctx, connectionId);
    if (!row.clientId) {
      throw new BadRequestException(
        'Save this connection’s Gitea client ID and secret before authorizing it',
      );
    }
    const redirectUri = await this.settleRedirectUri(
      ctx,
      kind,
      connectionId,
      row.redirectUri,
      base,
    );
    const state = await this.states.issue({
      purpose: 'authorize',
      providerType: 'gitea',
      gitProviderId: row.gitProviderId,
      returnTo,
      redirectUri,
    });
    const query = new URLSearchParams({
      client_id: row.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state: state.state,
      // OAuth 2 delimits scopes with spaces; the column stores Gitea's own
      // comma-joined default, which Gitea itself reads as a single scope.
      scope: (row.scopes || GITEA_DEFAULT_SCOPES).split(',').join(' '),
    });
    return {
      state: state.state,
      redirectUri,
      url: `${publicOnly(row.giteaUrl)}/login/oauth/authorize?${query.toString()}`,
    };
  }

  /**
   * The return leg: trade the `?code=` for the connection's first token pair
   * and, above all, for its `expiresAt`.
   */
  async completeAuthorization(
    kind: OauthProviderKind,
    query: OauthCallbackQueryDto,
  ): Promise<{ location: string }> {
    const state = await this.states.consume(query.state, {
      purpose: 'authorize',
      providerType: kind,
    });

    const row = await this.rowFor(kind, state.gitProviderId);
    const credentials =
      kind === 'gitlab'
        ? {
            clientId: (row as Gitlab).applicationId,
            clientSecret: (row as Gitlab).secret,
            tokenUrl: `${internalFirst(
              (row as Gitlab).gitlabUrl,
              (row as Gitlab).gitlabInternalUrl,
            )}/oauth/token`,
          }
        : {
            clientId: (row as Gitea).clientId,
            clientSecret: (row as Gitea).clientSecret,
            tokenUrl: `${internalFirst(
              (row as Gitea).giteaUrl,
              (row as Gitea).giteaInternalUrl,
            )}/login/oauth/access_token`,
          };
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new BadRequestException(
        'This connection no longer has the OAuth application credentials the exchange needs',
      );
    }
    // The provider compares this against the URI it redirected to, so it is the
    // one the authorize request carried rather than one derived again now — a
    // re-derivation behind a differently-named proxy would fail the exchange.
    if (!state.redirectUri) {
      throw new BadRequestException(
        'This connection attempt recorded no redirect URI, so its code cannot be exchanged',
      );
    }
    const redirectUri = state.redirectUri;

    // Through the connection's own guarded transport: the token URL is its
    // internal or public URL, dialled from the platform host.
    const result = await requestOAuthCodeExchange(
      kind === 'gitlab'
        ? this.gitlabService.fetchFor(row as Gitlab)
        : this.giteaService.fetchFor(row as Gitea),
      credentials.tokenUrl,
      {
        code: query.code,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        redirectUri,
      },
    );
    if (!result.ok) {
      throw new BadRequestException(
        `Failed to exchange the authorization code: ${result.statusText}`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const grant = {
      accessToken: result.grant.accessToken,
      refreshToken: result.grant.refreshToken,
      // The whole point of this route. `GitlabService.refreshToken` throws
      // whenever this is absent or past, so a connection without it is dead.
      expiresAt: now + (result.grant.expiresIn ?? 3600),
    };
    if (kind === 'gitlab') {
      await this.db
        .update(gitlab)
        .set(grant)
        .where(eq(gitlab.gitProviderId, state.gitProviderId));
    } else {
      await this.db
        .update(gitea)
        .set({ ...grant, lastAuthenticatedAt: now })
        .where(eq(gitea.gitProviderId, state.gitProviderId));
    }
    return { location: `${state.returnTo}?connected=${kind}` };
  }

  /**
   * The callback URL this connection uses. A stored one wins — it is what the
   * OAuth application at the provider has registered — and a connection without
   * one gets the derived value written back, so the console can show the value
   * that has to be registered rather than leaving it to be guessed.
   *
   * **Except the one this code used to write itself:** the same route on
   * the console's origin without its `/backend` prefix, which the console
   * answers with its sign-in redirect or its 404 page. No handshake has ever
   * completed through that value, so replacing it breaks nothing that worked —
   * and keeping it would make every later authorize fail the same way.
   */
  private async settleRedirectUri(
    ctx: PermissionCtx,
    kind: OauthProviderKind,
    connectionId: string,
    stored: string | null | undefined,
    base: string,
  ): Promise<string> {
    if (stored && stored !== unprefixedCallbackUrlFor(base, kind)) {
      return stored;
    }
    const derived = callbackUrlFor(base, kind);
    if (kind === 'gitlab') {
      await this.gitlabService.update(ctx, connectionId, {
        redirectUri: derived,
      });
    } else {
      await this.giteaService.update(ctx, connectionId, {
        redirectUri: derived,
      });
    }
    return derived;
  }

  /**
   * The strategy row behind a base provider id, secrets included. Not
   * org-scoped: the callback is unauthenticated and the consumed state is the
   * authority, so there is no session to scope by.
   */
  private async rowFor(
    kind: OauthProviderKind,
    gitProviderId: string,
  ): Promise<Gitlab | Gitea> {
    if (kind === 'gitlab') {
      const [row] = await this.db
        .select()
        .from(gitlab)
        .where(eq(gitlab.gitProviderId, gitProviderId))
        .limit(1);
      if (!row) throw new BadRequestException('GitLab provider not found');
      return row;
    }
    const [row] = await this.db
      .select()
      .from(gitea)
      .where(eq(gitea.gitProviderId, gitProviderId))
      .limit(1);
    if (!row) throw new BadRequestException('Gitea provider not found');
    return row;
  }
}
