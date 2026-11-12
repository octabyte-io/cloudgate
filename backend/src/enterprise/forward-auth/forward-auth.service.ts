import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  PreconditionFailedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { application } from '../../applications/application.schema';
import { runTeardownSteps } from '../../common/teardown-steps';
import type { UnreclaimedArtifact } from '../../common/teardown-steps';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { domain } from '../../domains/domain.schema';
import { DomainsService } from '../../domains/domains.service';
import { hostSchema } from '../../domains/dto/domain.dto';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import { server } from '../../servers/server.schema';
import { PermissionService } from '../../rbac/permission.service';
import { ServersService } from '../../servers/servers.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import type { AuditEventInput } from '../audit-logs/audit-log.service';
import { LicenseService } from '../license/license.service';
import { paidFeatureRefusal } from '../license/paid-features';
import { ssoProvider } from '../sso/sso.schema';
import { ForwardAuthProxyService } from './forward-auth-proxy.service';
import { buildAuthDomainRouter } from '../../traefik/config/forward-auth';
import type { AuthDomainConfig } from '../../traefik/config/forward-auth';
import type { CertificateType } from '../../traefik/config/types';
import {
  dynamicTraefikConfigPath,
  PLATFORM_OWNED,
  TraefikWriterService,
} from '../../traefik/traefik-writer.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { forwardAuthSettings } from './forward-auth.schema';
import type { ForwardAuthSettings } from './forward-auth.schema';
import {
  deriveBaseDomain,
  deriveCookieSecret,
  forwardAuthCallbackUrl,
} from './forward-auth.utils';
import type { ForwardAuthOidcConfig } from './forward-auth.utils';

/** The auth domain settings for one Traefik instance (null: the local one). */
export interface SetAuthDomainInput {
  serverId: string | null;
  authDomain: string;
  https: boolean;
  certificateType: CertificateType;
  customCertResolver?: string | null;
}

/**
 * Name of the shared Traefik config carrying the auth domain's /oauth2 router.
 * Not an app name — it rides the same per-name writer.
 */
export const AUTH_DOMAIN_CONFIG_NAME = 'forward-auth-domain';

/** How long a proxy probe may take before the target reads as 'unknown'. */
const FORWARD_AUTH_CHECK_TIMEOUT_MS = 4000;

/**
 * What a target's proxy reads as. 'stopped' is *no proxy deployed*; 'failing'
 * is a proxy that was deployed and has no replica running, which used to be
 * indistinguishable from 'running' because the check only asked whether the
 * swarm service object existed. 'unknown' is the probe itself failing.
 */
export type ProxyStatus = 'running' | 'failing' | 'stopped' | 'unknown';

/** A status reading with the sentence the settings screen shows beside it. */
interface ProxyReading {
  status: ProxyStatus;
  /** Non-null only when there is something to say beyond the status word. */
  message: string | null;
}

/** An identity provider a proxy can be deployed for. */
export interface ProviderChoice {
  providerId: string;
  issuer: string;
  domain: string;
}

/** One Traefik instance as the SSO settings screen sees it. */
export interface ForwardAuthTargetStatus {
  serverId: string | null;
  name: string;
  ipAddress: string | null;
  status: ProxyStatus;
  /**
   * Why, when the status word is not the whole story: the failing proxy's own
   * last task error, or what stopped the probe. Null when there is nothing to
   * add.
   */
  message: string | null;
  authDomain: string | null;
  https: boolean;
  certificateType: CertificateType;
  customCertResolver: string | null;
  callbackUrl: string | null;
}

/** A target's auth domain settings with the callback URL they imply. */
export interface AuthDomainView {
  host: string;
  https: boolean;
  certificateType: CertificateType;
  customCertResolver: string | null;
  callbackUrl: string;
}

/**
 * SSO forward-auth: the per-Traefik-instance auth domain and oauth2-proxy
 * deployment, and the per-domain gate that routes an application's requests
 * through that proxy.
 */
@Injectable()
export class ForwardAuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ForwardAuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly traefikWriter: TraefikWriterService,
    private readonly proxy: ForwardAuthProxyService,
    private readonly config: ConfigService,
    private readonly permissions: PermissionService,
    private readonly domains: DomainsService,
    private readonly license: LicenseService,
    private readonly servers: ServersService,
    private readonly auditLogs: AuditLogService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The gate every server-level method rides: an owner/admin caller. The
   * per-domain gate (status/enable/disable) is *not* behind it — those check
   * the `domain` permission instead, so a member with domain rights keeps
   * managing gates the owner already deployed a proxy for.
   *
   * The role checked is the caller's role in the organization, not the admin
   * plugin's global user role, which on a self-hosted instance is always 'user'
   * (the settings/ai/custom-roles precedent).
   *
   * Reads and removals ride this alone (ADR-0054): below the paid
   * features the page still shows what is set up and "Still protected", and
   * removing is always allowed, so an Organization can leave cleanly.
   */
  private async ensureManager(ctx: PermissionCtx): Promise<void> {
    const memberRecord = await this.permissions.findMember(ctx);
    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage forward-auth',
      );
    }
  }

  /**
   * The paid-feature check (the license key Self-hosted, Business or
   * Enterprise Hosted), asked by the writes that set forward auth up or
   * change it: the auth domain, deploying the proxy, gating a domain.
   *
   * Protection already in place never asks it. The Traefik middleware, the
   * proxy ({@link ForwardAuthProxyService}) and {@link sweepAuthDomain} read
   * no plan, so a plan change never makes a gated app public.
   */
  private async ensurePaidFeatures(ctx: PermissionCtx): Promise<void> {
    const licensed = await this.license.hasValidLicense(
      ctx.session.activeOrganizationId,
    );
    if (!licensed) throw paidFeatureRefusal(this.instanceMode);
  }

  /** {@link ensureManager} and {@link ensurePaidFeatures}: setting up or editing. */
  private async ensureEnterprise(ctx: PermissionCtx): Promise<void> {
    await this.ensureManager(ctx);
    await this.ensurePaidFeatures(ctx);
  }

  /** The target's auth domain; null when the target has no settings row. */
  async getAuthDomain(
    ctx: PermissionCtx,
    serverId: string | null,
  ): Promise<AuthDomainView | null> {
    await this.ensureManager(ctx);
    await this.assertTargetAuthority(ctx, serverId);
    const settings = await this.findSettings(serverId);
    if (!settings) return null;
    return {
      host: settings.authDomain,
      https: settings.https,
      certificateType: settings.certificateType,
      customCertResolver: settings.customCertResolver,
      callbackUrl: forwardAuthCallbackUrl(settings.authDomain, settings.https),
    };
  }

  /**
   * Upserts the target's auth domain settings and, while a proxy is deployed
   * on the target, writes the /oauth2 router for it into the target's Traefik
   * file provider; with no proxy there, the router is removed instead and
   * {@link deployOnServer} writes it.
   */
  async setAuthDomain(
    ctx: PermissionCtx,
    input: SetAuthDomainInput,
    ip?: string,
  ): Promise<{ callbackUrl: string }> {
    await this.ensureEnterprise(ctx);
    await this.assertTargetAuthority(ctx, input.serverId);
    const baseDomain = deriveBaseDomain(input.authDomain);

    const values = {
      authDomain: input.authDomain,
      baseDomain,
      https: input.https,
      certificateType: input.certificateType,
      customCertResolver: input.customCertResolver ?? null,
    };

    // One upsert on the machine key rather than a read and then an insert
    // (§2.3): two first saves racing on a machine with no row both inserted,
    // which on a Server answered a unique-violation 500 and on the platform
    // host, before `0084_forward-auth-local-unique.sql`, wrote a second row
    // that `findSettings` might answer instead of the first. The
    // platform-host row is unique only through the partial index
    // `forward_auth_settings_local_unique`, so its conflict target carries
    // that index's `WHERE`, as `DnsChallengeService.put`'s does.
    await this.db
      .insert(forwardAuthSettings)
      .values({ ...values, serverId: input.serverId })
      .onConflictDoUpdate({
        target: forwardAuthSettings.serverId,
        targetWhere: input.serverId
          ? undefined
          : isNull(forwardAuthSettings.serverId),
        set: values,
      });

    // The router follows the service, not the row. Removing the proxy
    // keeps the row, and clearing the domain deletes it while the proxy runs,
    // so neither says whether `cloudgate-forward-auth:4180` answers — the
    // service on the target does. 'stopped' also takes a file an earlier
    // version left; a probe that did not answer ('unknown') writes, as every
    // earlier version did, since removing the router from under a live
    // proxy would break sign-in on every gated Domain.
    const { status } = await this.proxyStatus(input.serverId);
    if (status === 'stopped') {
      await this.traefikWriter.removeConfig(
        AUTH_DOMAIN_CONFIG_NAME,
        input.serverId,
        // A null target is the platform host's one proxy, which only instance
        // authority reaches (`assertTargetAuthority`).
        PLATFORM_OWNED,
      );
    } else {
      await this.writeAuthDomainRouter(input.serverId, {
        authDomain: input.authDomain,
        https: input.https,
        certificateType: input.certificateType,
        customCertResolver: input.customCertResolver,
      });
    }

    await this.audit(ctx, ip, {
      action: 'update',
      resourceType: 'server',
      resourceId: input.serverId ?? 'local',
      resourceName: 'forward-auth-domain',
    });

    return {
      callbackUrl: forwardAuthCallbackUrl(input.authDomain, input.https),
    };
  }

  /**
   * Take an auth domain that is not a hostname back out of the file provider
   * (H-39).
   *
   * **The same shape as H-25, one file over, and it needs the same
   * mechanism for the same reason.** The writers of
   * `dynamic/forward-auth-domain.yml` are {@link setAuthDomain}, which builds
   * {@link buildAuthDomainRouter} from `SetAuthDomainDto`'s validated input,
   * and {@link deployOnServer}, which builds it from the row only after
   * {@link assertDeployableAuthDomain} has held it to `hostSchema` — so every
   * write is safe and a value stored before `domainRegex` is never shown to a
   * rule again. It sits in
   * ``Host(`${cfg.authDomain}`) && PathPrefix(`/oauth2/`)`` at priority 1000,
   * where a backtick closes the argument and appends alternations of its own,
   * and it is *never revisited*: no regeneration re-emits it, so the emitter
   * guard put on `TraefikAppConfigService.findAuthGate` cannot reach
   * it. That guard covers the **per-app** gate — the middleware address every
   * gated Domain dials — and this file is the other half, the central
   * `/oauth2/*` router. Boot is the one moment an instance is guaranteed to
   * look at these rows.
   *
   * **Every row, and each one on its own.** Unlike the console host there is
   * not one row but one per Traefik instance, and a remote row's file lives on
   * that Server over SSH, which can be unreachable, slow or rebuilt. So the
   * loop is per row and each removal is caught: one Server that will not answer
   * must not stop the sweep of the others, and the cost is bounded because the
   * only thing that runs at boot on a healthy instance is a single local
   * SELECT — SSH is reached for a *poisoned* row and no other.
   *
   * **Where this deliberately differs from `SettingsService.sweepConsoleHost`:
   * the row is left alone.** That sweep clears `webServerSettings.host`
   * because a poisoned console host is not inert while it is stored — it mints
   * every notification's dashboard link and makes `assertHostUnclaimed` reserve
   * the poisoned string — and because `''` is a documented "no console domain"
   * state every reader already handles. Neither is true here. `authDomain` is
   * `notNull()` and the row's whole existence *is* the auth domain, so the only
   * way to empty it is to delete the row, which would also throw away the
   * operator's `providerId`, `certificateType` and `customCertResolver` — three
   * columns nobody poisoned. And what remains of the stored value once this
   * file is gone is already held: `findAuthGate` refuses it at the emitter
   * (H-23), {@link deployOnServer} refuses it at the container env (H-40), and
   * the only other reader is the `callbackUrl` the SSO settings screen puts in
   * a read-only field for the operator to copy into their identity provider.
   * That last one is the reason *not* to clear it — an operator who cannot see
   * the value cannot tell what to correct, and correcting it is the whole
   * remediation. A console host had somewhere safe to fall back to; an auth
   * domain has only the operator.
   *
   * Like its sibling, this does not guess. The injected half is
   * attacker-chosen, a salvaged router is a router nobody decided on, and
   * re-running {@link setAuthDomain} is the remediation the log line names.
   */
  async sweepAuthDomain(): Promise<void> {
    const rows = await this.db
      .select({
        serverId: forwardAuthSettings.serverId,
        authDomain: forwardAuthSettings.authDomain,
      })
      .from(forwardAuthSettings);

    for (const row of rows) {
      if (hostSchema.safeParse(row.authDomain).success) continue;

      const target = row.serverId ?? 'the platform host';
      this.logger.error(
        `The stored forward-auth domain for ${target} is not a hostname, so its /oauth2 router has been removed from the Traefik file provider. ` +
          'Set the authentication domain again in SSO settings to restore it.',
      );
      try {
        await this.traefikWriter.removeConfig(
          AUTH_DOMAIN_CONFIG_NAME,
          row.serverId,
          PLATFORM_OWNED,
        );
      } catch (error) {
        // A Server that will not answer is one row's problem, not the sweep's.
        this.logger.error(
          `Could not remove the forged /oauth2 router from ${target}; it is still live there.`,
          error as Error,
        );
      }
    }
  }

  /**
   * Boot-time auth-domain sweep, tolerant of an un-migrated database — the
   * `SettingsService.onApplicationBootstrap` precedent, which is
   * `DockerCleanupService`'s. A sweep that cannot run is a sweep that did not
   * happen, never a boot that fails: the forged router predates this process
   * and refusing to start would leave it live *and* take the console down.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sweepAuthDomain();
    } catch (error) {
      this.logger.error('Auth domain sweep at boot failed', error as Error);
    }
  }

  /**
   * Stands the oauth2-proxy up on the target with the provider's OIDC config,
   * and records the provider it now authenticates against.
   */
  async deployOnServer(
    ctx: PermissionCtx,
    input: { serverId: string | null; providerId: string },
    ip?: string,
  ): Promise<{ ok: true }> {
    await this.ensureEnterprise(ctx);
    await this.assertTargetAuthority(ctx, input.serverId);
    const settings = await this.findSettings(input.serverId);
    if (!settings) {
      throw new PreconditionFailedException(
        'Set the authentication domain for this server before deploying the proxy.',
      );
    }

    const authDomain = this.assertDeployableAuthDomain(settings);
    // Derived here, not read off `settings.baseDomain` — see
    // {@link assertDeployableAuthDomain}.
    const baseDomain = deriveBaseDomain(authDomain);

    const provider = await this.findProviderForOrg(
      input.providerId,
      ctx.session.activeOrganizationId,
    );
    const oidc = this.resolveOidcConfig(provider);

    await this.proxy.setup({
      serverId: input.serverId,
      oidc,
      cookieSecret: deriveCookieSecret(
        this.config.getOrThrow<string>('BETTER_AUTH_SECRET'),
        `${input.serverId ?? 'host'}:${baseDomain}`,
      ),
      authDomain,
      baseDomain,
      authDomainHttps: settings.https,
    });

    // The router goes with the service: written once the service it
    // names exists, from the same checked host the container was configured
    // with rather than the raw column.
    await this.writeAuthDomainRouter(input.serverId, {
      authDomain,
      https: settings.https,
      certificateType: settings.certificateType,
      customCertResolver: settings.customCertResolver,
    });

    if (settings.providerId !== input.providerId) {
      await this.db
        .update(forwardAuthSettings)
        .set({ providerId: input.providerId })
        .where(this.settingsWhere(input.serverId));
    }

    await this.audit(ctx, ip, {
      action: 'create',
      resourceType: 'server',
      resourceId: input.serverId ?? 'local',
      resourceName: 'forward-auth',
    });
    return { ok: true };
  }

  /**
   * The stored auth domain, held to `hostSchema` before it configures the
   * oauth2-proxy container (H-40).
   *
   * **Three environment variables, and none of them is a shell.** `Env` is a
   * dockerode array, so a byte in the value cannot forge a second variable and
   * this is not command injection. It is a *scope* problem, and each of the
   * three widens something different:
   *
   * - `OAUTH2_PROXY_REDIRECT_URL=${scheme}://${authDomain}/oauth2/callback`
   *   takes the stored value raw, so it carries H-23's separators unchanged:
   *   `/`, `#`, `@` and `?` each move which host the OIDC `redirect_uri` names.
   *   Against an identity provider that matches its registered redirect URI
   *   exactly, that breaks every sign-in through the gate; against one
   *   registered with a wildcard or a prefix, the authorization **code** is
   *   delivered to a host the operator did not choose.
   * - `OAUTH2_PROXY_WHITELIST_DOMAINS=${baseDomain}` is the one that matters,
   *   and it matters because of two documented oauth2-proxy behaviours.
   *   `--whitelist-domain` is *"allowed domains for redirection after
   *   authentication"* — the `rd` parameter, which is not exotic here: the
   *   errors middleware this repo writes drives every unauthenticated request
   *   through `/oauth2/sign_in?rd={url}` (`traefik/config/forward-auth.ts:55`).
   *   And it is a `string | list` option, so its environment form is
   *   **comma-separated**. {@link deriveBaseDomain} splits on `.` and nothing
   *   else, so a `,` in the stored value survives it intact: a row reading
   *   `auth.example.com,.attacker.tld` derives `.example.com,.attacker.tld`,
   *   which oauth2-proxy reads as *two* whitelisted domains. The legitimate one
   *   is still there, so nothing looks broken — and an authenticated redirect
   *   can now leave the instance for anywhere under `attacker.tld`.
   * - `OAUTH2_PROXY_COOKIE_DOMAINS=${baseDomain}` splits the same way, but it
   *   is the weaker half and is written down as the weaker half: oauth2-proxy
   *   picks *"the longest domain matching the request's host"*, and the only
   *   host that reaches this proxy is the one the `forward-auth-oauth` router
   *   matches, so an injected entry is never selected. What a poisoned cookie
   *   domain actually buys is breakage — a `Set-Cookie` the browser rejects,
   *   which is a sign-in loop, not a leak.
   *
   * **`.` matters, and `deriveBaseDomain` always adds one.** Both variables are
   * therefore suffix-scoped rather than exact: `.attacker.tld` admits *any*
   * subdomain of it, where `attacker.tld` would admit only the one host. One
   * injected entry is a whole namespace.
   *
   * **A 412, not `findAuthGate`'s silent null.** The distinction drawn
   * there was whose row is being refused. `findAuthGate` runs inside another
   * organization's Domain or redirect edit, on an instance-wide row only an
   * enterprise owner can fix, so throwing would punish the wrong caller. This
   * runs inside {@link deployOnServer} — an enterprise owner, deliberately
   * standing up the proxy for the target they configured — so the refusal lands
   * on exactly the person who can act on it, beside the `PreconditionFailed`
   * that already answers "you have not set an auth domain yet". Deploying a
   * proxy whose whitelist someone else chose is the one outcome that is not
   * available.
   *
   * **`baseDomain` is re-derived rather than validated.** It is a pure function
   * of `authDomain`, so the strongest available rule is not a charset on the
   * column but not reading the column: for every row {@link setAuthDomain}
   * wrote the two are byte-identical, and for any row written around it the
   * derivation is the one the operator's auth domain implies. That closes all
   * three variables with one guard, because a `hostSchema`-valid host contains
   * only letters, digits, hyphens and dots — no comma, no space, no separator
   * oauth2-proxy or a URL parser reads as syntax. The cookie-secret salt moves
   * with it on purpose: a row whose stored `baseDomain` disagreed with its
   * `authDomain` gets a different secret, which invalidates the sessions that
   * poisoned scope minted.
   *
   * `hostSchema` rather than the DTO's `domainRegex`, on H-23's reasoning: it
   * is the repo's hostname rule and it is strictly wider — lowercase-only with
   * an alphabetic TLD is a subset of `VALID_HOSTNAME_REGEX` — so nothing
   * written through {@link setAuthDomain} can trip this. Only a row that
   * predates the rule, or one written around it, can.
   */
  private assertDeployableAuthDomain(settings: ForwardAuthSettings): string {
    const checked = hostSchema.safeParse(settings.authDomain);
    if (!checked.success) {
      // The stored value is not echoed: repeating an injection payload into an
      // error body puts it somewhere new for no gain (§2.5).
      throw new PreconditionFailedException(
        'The authentication domain stored for this server is not a hostname, so the proxy cannot be configured from it. Set the authentication domain again before deploying the proxy.',
      );
    }
    return checked.data;
  }

  /**
   * The organization's OIDC providers, oldest first — the only ones a
   * forward-auth proxy can be deployed for.
   */
  async listProviders(ctx: PermissionCtx): Promise<ProviderChoice[]> {
    await this.ensureManager(ctx);
    return this.db
      .select({
        providerId: ssoProvider.providerId,
        issuer: ssoProvider.issuer,
        domain: ssoProvider.domain,
      })
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
          isNotNull(ssoProvider.oidcConfig),
        ),
      )
      .orderBy(asc(ssoProvider.createdAt));
  }

  /**
   * Every Traefik instance this organization could gate — the local one plus
   * its reachable deploy servers — with the proxy's state and whatever auth
   * domain each already has.
   *
   * A target with no settings row reads as https with certificateType 'none',
   * which is *not* the column default — the screen shows an unconfigured form,
   * not a letsencrypt one.
   */
  async serverStatus(ctx: PermissionCtx): Promise<ForwardAuthTargetStatus[]> {
    await this.ensureManager(ctx);
    const servers = await this.db
      .select({
        serverId: server.serverId,
        name: server.name,
        ipAddress: server.ipAddress,
      })
      .from(server)
      .where(
        and(
          eq(server.organizationId, ctx.session.activeOrganizationId),
          isNotNull(server.sshKeyId),
          eq(server.serverType, 'deploy'),
        ),
      )
      .orderBy(desc(server.createdAt));

    const targets = [
      { serverId: null, name: 'Cloudgate Server (local)', ipAddress: null },
      ...servers,
    ];

    return Promise.all(
      targets.map(async (target) => {
        const settings = await this.findSettings(target.serverId);
        return {
          ...target,
          ...(await this.proxyStatus(target.serverId)),
          authDomain: settings?.authDomain ?? null,
          https: settings?.https ?? true,
          certificateType: settings?.certificateType ?? 'none',
          customCertResolver: settings?.customCertResolver ?? null,
          callbackUrl: settings
            ? forwardAuthCallbackUrl(settings.authDomain, settings.https)
            : null,
        };
      }),
    );
  }

  /**
   * One target's proxy reading. An unreachable server must not hang the
   * screen, so the probe is capped and anything that fails or times out reads
   * 'unknown'.
   *
   * A deployed proxy with nothing running is its own reading, not 'running' —
   * that conflation is what let a domain be gated behind a proxy answering
   * nothing — and it carries the task's error, because "0/1 replicas
   * running: task: non-zero exit (1)" is the only sentence anywhere that tells
   * the operator their client secret is wrong.
   */
  private async proxyStatus(serverId: string | null): Promise<ProxyReading> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const health = await Promise.race([
        this.proxy.health(serverId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            FORWARD_AUTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);

      if (!health.deployed) return { status: 'stopped', message: null };
      if (health.running > 0) return { status: 'running', message: null };

      const replicas = `${health.running}/${health.wanted} replicas running`;
      return {
        status: 'failing',
        message: health.lastError
          ? `${replicas}: ${health.lastError}`
          : replicas,
      };
    } catch {
      return {
        status: 'unknown',
        message: 'The proxy did not answer within four seconds.',
      };
    } finally {
      // The timer is the race's loser when the probe answers; it has to be
      // cleared or every probe holds the event loop open for four seconds.
      if (timer) clearTimeout(timer);
    }
  }

  /** Whether the domain is gated; needs the `domain` read permission. */
  async getDomainStatus(
    ctx: PermissionCtx,
    domainId: string,
  ): Promise<{ enabled: boolean }> {
    const gated = await this.findApplicationDomain(ctx, domainId);
    await this.assertDomainAccess(ctx, gated.applicationId, 'read');
    return { enabled: gated.forwardAuthEnabled };
  }

  /**
   * Gates the domain: its router starts sending requests through the server's
   * proxy. Refused unless that proxy has been deployed *and* is actually up — a
   * gate pointing at nothing would lock the application away behind a
   * middleware Traefik cannot reach.
   */
  async enableOnDomain(
    ctx: PermissionCtx,
    domainId: string,
    ip?: string,
  ): Promise<{ ok: true }> {
    const gated = await this.findApplicationDomain(ctx, domainId);
    await this.assertDomainAccess(ctx, gated.applicationId, 'create');
    // Gating a domain is setting forward auth up; ungating it never asks.
    await this.ensurePaidFeatures(ctx);

    const settings = await this.findSettings(gated.serverId);
    if (!settings?.providerId) {
      throw new PreconditionFailedException(
        'Deploy the authentication proxy for this server in SSO settings first.',
      );
    }

    const health = await this.proxy.health(gated.serverId);
    if (!health.deployed) {
      throw new PreconditionFailedException(
        'The authentication proxy is not deployed on this server. Deploy it in SSO settings first.',
      );
    }
    if (health.running === 0) {
      // The state this check is for: the service object exists, so the old
      // check passed, but nothing is answering on it. Gating here is what makes
      // the application unreachable, so the proxy's own words come back with
      // the refusal — it is the only place the real cause (a wrong client
      // secret, an issuer that does not resolve) is written down.
      throw new PreconditionFailedException(
        health.lastError
          ? `The authentication proxy on this server is deployed but no replica is running: ${health.lastError}`
          : 'The authentication proxy on this server is deployed but no replica is running. Check it in SSO settings before gating a domain.',
      );
    }

    await this.domains.update(ctx, domainId, { forwardAuthEnabled: true });

    await this.audit(ctx, ip, {
      action: 'update',
      resourceType: 'domain',
      resourceId: gated.domainId,
      resourceName: gated.host,
    });
    return { ok: true };
  }

  /**
   * Ungates the domain. Regenerating the app's config is what drops the
   * middlewares — the whole file is rebuilt from the domain rows, so nothing
   * has to be deleted out of a shared middlewares file.
   */
  async disableOnDomain(
    ctx: PermissionCtx,
    domainId: string,
    ip?: string,
  ): Promise<{ ok: true }> {
    const gated = await this.findApplicationDomain(ctx, domainId);
    await this.assertDomainAccess(ctx, gated.applicationId, 'create');

    await this.domains.update(ctx, domainId, { forwardAuthEnabled: false });

    await this.audit(ctx, ip, {
      action: 'update',
      resourceType: 'domain',
      resourceId: gated.domainId,
      resourceName: gated.host,
    });
    return { ok: true };
  }

  /**
   * The domain with the server its application runs on, org-scoped through
   * environment → project. Compose domains are refused: their routers travel as
   * deploy-time labels, which carry no forward-auth middleware.
   */
  private async findApplicationDomain(ctx: PermissionCtx, domainId: string) {
    const [row] = await this.db
      .select({
        domainId: domain.domainId,
        host: domain.host,
        forwardAuthEnabled: domain.forwardAuthEnabled,
        applicationId: domain.applicationId,
        composeId: domain.composeId,
        serverId: application.serverId,
      })
      .from(domain)
      .leftJoin(
        application,
        eq(domain.applicationId, application.applicationId),
      )
      .leftJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .leftJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(domain.domainId, domainId),
          or(
            isNull(domain.applicationId),
            eq(project.organizationId, ctx.session.activeOrganizationId),
          ),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException('Domain not found');
    if (!row.applicationId) {
      throw new BadRequestException(
        'SSO forward-auth is currently only supported on application domains',
      );
    }
    return { ...row, applicationId: row.applicationId };
  }

  /** The caller's `domain` permission for `action`, plus access to the app. */
  private async assertDomainAccess(
    ctx: PermissionCtx,
    applicationId: string,
    action: 'read' | 'create',
  ): Promise<void> {
    await this.permissions.checkPermission(ctx, { domain: [action] });
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
  }

  /**
   * Tears the proxy down and its /oauth2 router with it, and forgets the
   * provider, leaving the auth domain in place so it can be redeployed —
   * {@link deployOnServer} writes the router again.
   *
   * **The router is this removal's to take.** It names
   * `cloudgate-forward-auth:4180`, so once the service is gone a router left on
   * disk still matches the auth host and forwards to nothing: `/oauth2/*`
   * answered 502 while the card read "No proxy", and it outlived a Traefik
   * restart because it is a file. Only {@link removeAuthDomain} used to drop
   * it, so the exposed case was the one the card invites — removing the proxy
   * to redeploy it while keeping the domain.
   *
   * **A router that cannot be removed is reported, not raised**, in the
   * teardown shape (`common/teardown-steps.ts`'s `UnreclaimedArtifact`): the
   * service is already gone by then, so a 500 would tell the operator nothing
   * happened when the proxy in fact stopped, and the file's path on its
   * machine is what they need to finish the job by hand.
   */
  async removeOnServer(
    ctx: PermissionCtx,
    serverId: string | null,
    ip?: string,
  ): Promise<{ ok: true; unreclaimedArtifacts?: UnreclaimedArtifact[] }> {
    await this.ensureManager(ctx);
    await this.assertTargetAuthority(ctx, serverId);
    await this.proxy.remove(serverId);
    const unreclaimedArtifacts = await runTeardownSteps([
      {
        run: () =>
          this.traefikWriter.removeConfig(
            AUTH_DOMAIN_CONFIG_NAME,
            serverId,
            PLATFORM_OWNED,
          ),
        leftBehindOnFailure: {
          kind: 'traefik-config',
          appName: AUTH_DOMAIN_CONFIG_NAME,
          serverId,
          path: dynamicTraefikConfigPath(AUTH_DOMAIN_CONFIG_NAME, serverId),
        },
      },
    ]);
    await this.db
      .update(forwardAuthSettings)
      .set({ providerId: null })
      .where(this.settingsWhere(serverId));

    await this.audit(ctx, ip, {
      action: 'delete',
      resourceType: 'server',
      resourceId: serverId ?? 'local',
      resourceName: 'forward-auth',
    });
    // Absent rather than empty on a clean removal, the teardown shape's rule.
    return unreclaimedArtifacts.length
      ? { ok: true, unreclaimedArtifacts }
      : { ok: true };
  }

  /**
   * Authority over the target this call names — two questions, not one.
   *
   * **A `serverId` is a Server row.** One from another organization is not this
   * caller's to configure. Routed through ServersService so the scoping rule
   * lives in one place; a foreign server reads as absent (404) rather than
   * forbidden, matching every other org-scoped lookup here.
   *
   * **A null `serverId` is the platform host, and the platform host is not any
   * organization's** (H-51). This branch used to return immediately — a correct
   * copy of `checkServerAccess`'s documented "no server row to check" contract
   * (ADR-0008's second consequence), mistaken for the whole answer.
   * {@link ensureEnterprise} had already admitted an owner or admin of the
   * caller's *active* organization, so an owner of any licensed organization on
   * the instance could rewrite `dynamic/forward-auth-domain.yml` for the whole
   * platform host and stand the single instance-wide oauth2-proxy up against
   * their own `sso_provider`. Every other organization's gated Domain dials
   * that one proxy and `OAUTH2_PROXY_EMAIL_DOMAINS=*`
   * (`forward-auth.utils.ts`) admits whatever identity its issuer mints: a
   * cross-organization authentication bypass rather than a misconfiguration.
   *
   * The suite's existing *"cannot configure a server belonging to another
   * organization"* pins a foreign **non-null** id, which is exactly why the
   * null one stayed invisible. `serverId: null` now has its own test.
   *
   * Renamed from `assertServerInOrg`: the null target is not in an
   * organization, and a name claiming it was is what made the hole readable as
   * complete. Nothing outside this file referred to it.
   */
  private async assertTargetAuthority(
    ctx: PermissionCtx,
    serverId: string | null,
  ): Promise<void> {
    if (!serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
      return;
    }
    await this.servers.findOne(ctx, serverId);
  }

  /** The organization's provider with this `providerId`, or 404. */
  private async findProviderForOrg(providerId: string, organizationId: string) {
    const [provider] = await this.db
      .select({
        providerId: ssoProvider.providerId,
        issuer: ssoProvider.issuer,
        oidcConfig: ssoProvider.oidcConfig,
      })
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, providerId),
          eq(ssoProvider.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!provider) throw new NotFoundException('SSO provider not found');
    return provider;
  }

  /**
   * The provider's OIDC client settings, parsed out of its stored blob.
   * oauth2-proxy speaks OIDC only, so a SAML-only provider (no `oidcConfig`)
   * cannot front a forward-auth gate.
   */
  private resolveOidcConfig(provider: {
    issuer: string;
    oidcConfig: string | null;
  }): ForwardAuthOidcConfig {
    if (!provider.oidcConfig) {
      throw new BadRequestException(
        'Forward-auth requires an OIDC provider — SAML is not supported.',
      );
    }

    let parsed: Partial<ForwardAuthOidcConfig>;
    try {
      parsed = JSON.parse(
        provider.oidcConfig,
      ) as Partial<ForwardAuthOidcConfig>;
    } catch {
      throw new InternalServerErrorException(
        'Failed to parse the SSO provider OIDC configuration',
      );
    }

    if (!parsed?.clientId || !parsed?.clientSecret) {
      throw new BadRequestException(
        'SSO provider OIDC config is missing clientId/clientSecret',
      );
    }

    return {
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      issuer: provider.issuer,
      scopes: parsed.scopes,
      skipDiscovery: parsed.skipDiscovery,
    };
  }

  /**
   * Removes the target's /oauth2 router and its settings row; a target with no
   * row is already in that state.
   */
  async removeAuthDomain(
    ctx: PermissionCtx,
    serverId: string | null,
    ip?: string,
  ): Promise<{ ok: true }> {
    await this.ensureManager(ctx);
    await this.assertTargetAuthority(ctx, serverId);
    const existing = await this.findSettings(serverId);
    if (!existing) return { ok: true };

    await this.traefikWriter.removeConfig(
      AUTH_DOMAIN_CONFIG_NAME,
      serverId,
      PLATFORM_OWNED,
    );
    await this.db
      .delete(forwardAuthSettings)
      .where(this.settingsWhere(serverId));

    await this.audit(ctx, ip, {
      action: 'delete',
      resourceType: 'server',
      resourceId: serverId ?? 'local',
      resourceName: 'forward-auth-domain',
    });
    return { ok: true };
  }

  /**
   * Writes the target's /oauth2 router — the one shape both writers emit.
   * `cfg.authDomain` must already be a checked host: the DTO's, or the row's
   * after {@link assertDeployableAuthDomain} (H-39).
   */
  private writeAuthDomainRouter(
    serverId: string | null,
    cfg: AuthDomainConfig,
  ): Promise<void> {
    return this.traefikWriter.writeConfig(
      AUTH_DOMAIN_CONFIG_NAME,
      buildAuthDomainRouter(cfg),
      serverId,
      // A null target is the platform host's one proxy, which only instance
      // authority reaches (`assertTargetAuthority`).
      PLATFORM_OWNED,
    );
  }

  /** Records an audit event as the caller, in their active organization. */
  private audit(
    ctx: PermissionCtx,
    ip: string | undefined,
    event: AuditEventInput,
  ): Promise<string | null> {
    return this.auditLogs.audit(
      {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
        ip,
      },
      event,
    );
  }

  private settingsWhere(serverId: string | null) {
    return serverId
      ? eq(forwardAuthSettings.serverId, serverId)
      : isNull(forwardAuthSettings.serverId);
  }

  private async findSettings(
    serverId: string | null,
  ): Promise<ForwardAuthSettings | null> {
    const [row] = await this.db
      .select()
      .from(forwardAuthSettings)
      .where(this.settingsWhere(serverId))
      .limit(1);
    return row ?? null;
  }
}
