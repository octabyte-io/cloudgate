import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { hash } from 'bcryptjs';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { rethrowIfHostUnreachable } from '../docker-ops/host-reachability';
import type { DrizzleTx } from '../environments/config-name';
import {
  application,
  domain,
  forwardAuthSettings,
  redirect,
  security,
} from '../db/schema';
import {
  hostSchema,
  storedDomainRoutingSchema,
} from '../domains/dto/domain.dto';
import { storedRedirectSchema } from '../networking/redirects/dto/redirect.dto';
import { storedSecurityUserSchema } from '../networking/security/dto/security.dto';
import { createTraefikConfig } from './config/application';
import { createComposeStackTraefikConfig } from './config/compose-stack';
import type { HttpMiddleware } from './config/file-types';
import { createForwardAuthMiddlewares } from './config/forward-auth';
import { createPathMiddlewares } from './config/middleware';
import {
  buildRouterSubjectIndex,
  composeStackConfigName,
} from './config/names';
import { createPreviewTraefikConfig, previewRoute } from './config/preview';
import { createRedirectMiddleware } from './config/redirect';
import { createBasicAuthMiddleware } from './config/security';
import type { TraefikApp } from './config/types';
import { TraefikConfigStatusService } from './config-status.service';
import { TraefikWriterService } from './traefik-writer.service';

/** The application columns a config regeneration needs. */
export interface TraefikAppRef {
  applicationId: string;
  appName: string;
  serverId: string | null;
}

/**
 * What routing one preview deployment takes: its own name and host, the
 * port its parent's `previewPort` names, and the parent it borrows from.
 */
export interface TraefikPreviewRef {
  /** The preview's own `appName` — its file, its routers and its backend. */
  appName: string;
  /** `preview_deployment.domain`, carved out of the parent's wildcard. */
  host: string;
  port: number;
  /**
   * The parent Application: its run Server is where the preview's Swarm
   * service runs and so whose Traefik serves it, and its basic-auth users are
   * the ones the preview is put behind.
   */
  parent: Pick<TraefikAppRef, 'applicationId' | 'serverId'>;
  /**
   * The wildcard the `websecure` router asks the machine's DNS-01 resolver
   * for — the parent's `previewWildcard` while its `previewDnsChallenge` is on
   * — or `null` for `tls: {}`. See `config/preview.ts`'
   * `previewRouterTls`.
   */
  dnsChallengeWildcard: string | null;
}

/** The bucket columns routing a bucket's Domains needs. */
export interface TraefikBucketRef {
  bucketId: string;
  appName: string;
  serverId: string | null;
}

/** The compose columns routing a `stack` Compose's Domains needs. */
export interface TraefikComposeStackRef {
  composeId: string;
  appName: string;
  serverId: string | null;
}

/**
 * A preview's stored host, held to the hostname rule at the emitter.
 *
 * `previewWildcard` has been refused unless it is `*.` plus a hostname since
 * H-41, which said in so many words that it was pre-empting *this* day:
 * the first time a preview host reaches a `Host()` rule. A row minted before
 * that rule is a value no write will revisit, so the check is here, on the set
 * about to be written, exactly as `regenerate` does it for a Domain's `host`.
 */
const storedPreviewHostSchema = z.object({ host: hostSchema });

/**
 * Why a Preview deployment of a Service in a Cloud account gets no router: the
 * platform host's Traefik is not where its parent runs.
 */
export const CLOUD_PREVIEW_NOT_ROUTED =
  "A Preview deployment of a Service in a Cloud account is not routed: its Domains are its cloud's load balancer's, and this Cloudgate's own Traefik does not serve it.";

/**
 * Rebuilds an application's per-app dynamic config from its current
 * domain, redirect and security rows. The whole file is regenerated from
 * scratch on every change rather than patched, and the writer drops it when
 * the last domain is gone. Everything the app's routers reference — path,
 * redirect, basic-auth middlewares — lives in the same file; nothing is
 * written to a shared middlewares file.
 */
@Injectable()
export class TraefikAppConfigService {
  private readonly logger = new Logger(TraefikAppConfigService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly writer: TraefikWriterService,
    private readonly status: TraefikConfigStatusService,
  ) {}

  /**
   * One stored row's values, or a 400 naming the row and the field that is
   * wrong (H-14 for Domains, H-22 for basic-auth users, H-24 for
   * redirects).
   *
   * Extracted rather than written three times: the three guards below differ
   * only in which noun they name, and the sentence they answer with is the one
   * an operator has to act on. Named fields only, and the value is never
   * echoed — repeating a stored injection payload into an error body puts it
   * somewhere new for no gain (§2.5).
   */
  private assertStoredValuesSafe(
    schema: z.ZodType,
    row: unknown,
    subject: { noun: string; id: string },
  ): void {
    const checked = schema.safeParse(row);
    if (checked.success) return;

    const fields = checked.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join('; ');
    throw new BadRequestException(
      `${subject.noun} ${subject.id} has a stored value Traefik cannot be given — ${fields}. Correct or delete that ${subject.noun}; a request that does not carry the field cannot fix it`,
    );
  }

  /**
   * Rewrites one Application's file from its stored rows, read through `db`:
   * this service's own handle, or the transaction of a caller that has just
   * written those rows and must not commit them unless the file is written.
   * An Application's port change is that caller (ADR-0068): it moves the
   * Domains on the old port and rewrites their routing before it commits, so
   * a rewrite that fails leaves the port and its Domains as they were.
   */
  async regenerate(
    app: TraefikAppRef,
    db: DrizzleDB | DrizzleTx = this.db,
  ): Promise<void> {
    // A Service in a Cloud account has no Traefik: its Domains are rules on
    // its cloud's load balancer, made by their own short Cloud runs (CONTEXT.md
    // "Domain"). Its `serverId` is `null` all the same, which the writer reads
    // as the platform host, so a redirect, a basic-auth user or a port change
    // on one wrote its Domains' `Host() && PathPrefix()` routers into the
    // platform host's own Traefik, beside the console's, where the longer rule
    // wins. Asked of the stored row here, so no caller can forget it; nothing
    // is written or removed (removing would delete whatever file of the
    // platform host's happens to share the name).
    if (await this.inCloud(app.applicationId, db)) return;

    const domains = await db
      .select()
      .from(domain)
      .where(eq(domain.applicationId, app.applicationId));

    // X05-1, H-14/H-20. Every caller of this method rewrites the whole
    // file from stored rows, and three of them — `RedirectsService`,
    // `SecurityService` and `DomainsService` — reach it from a request that
    // never named a Domain at all. A row written before the DTO rules
    // therefore goes on being re-emitted indefinitely, injected `PathPrefix`
    // alternation and all: editing an unrelated redirect is enough. Guarding
    // `DomainsService` alone left those two callers around the outside, which
    // is why the check lives at the emitter and not at the DTO. The rule is the
    // DTO's own schemas, applied here to the set about to be written rather
    // than restated (§2.4).
    for (const row of domains) {
      this.assertStoredValuesSafe(storedDomainRoutingSchema, row, {
        noun: 'Domain',
        id: row.domainId,
      });
    }

    if (domains.length === 0) {
      await this.onServer(app.serverId, () =>
        this.writer.removeConfig(app.appName, app.serverId),
      );
      return;
    }

    const redirects = await db
      .select()
      .from(redirect)
      .where(eq(redirect.applicationId, app.applicationId));
    const securityRows = await db
      .select()
      .from(security)
      .where(eq(security.applicationId, app.applicationId));

    // H-24, H-22. The same guard the Domain rows get above, for the two
    // other tables this method reads and interpolates. Both are reachable
    // without the caller naming the row: `updateRedirectSchema` and
    // `updateSecuritySchema` are both `.partial()`, and `DomainsService` gets
    // here without touching either table at all — so a row stored before its
    // rule existed is re-emitted rather than left dormant, which is the
    // mechanism X05-1 filed. The rule is each DTO's own schema applied
    // to the set about to be written, never restated (§2.4).
    for (const row of redirects) {
      this.assertStoredValuesSafe(storedRedirectSchema, row, {
        noun: 'Redirect',
        id: row.redirectId,
      });
    }
    for (const row of securityRows) {
      this.assertStoredValuesSafe(storedSecurityUserSchema, row, {
        noun: 'Basic-auth user',
        id: row.securityId,
      });
    }

    const traefikApp: TraefikApp = {
      appName: app.appName,
      redirects,
      security: securityRows,
    };
    const config = createTraefikConfig(traefikApp, domains);

    const middlewares: Record<string, HttpMiddleware> = {};
    for (const row of domains) {
      Object.assign(middlewares, createPathMiddlewares(app.appName, row));
    }
    for (const row of redirects) {
      Object.assign(middlewares, createRedirectMiddleware(app.appName, row));
    }
    // A gated domain needs the gate its router names, and the gate needs the
    // auth domain the server's proxy answers on. A domain gated on a server
    // with no auth domain silently gets no middleware; the enable path refuses
    // that state up front.
    const gated = domains.filter((row) => row.forwardAuthEnabled);
    if (gated.length > 0) {
      const authGate = await this.findAuthGate(app.serverId);
      if (authGate) {
        for (const row of gated) {
          Object.assign(
            middlewares,
            createForwardAuthMiddlewares(
              app.appName,
              row.uniqueConfigKey,
              authGate,
            ),
          );
        }
      }
    }

    const users = await this.basicAuthUsers(securityRows);
    if (users.length > 0) {
      Object.assign(middlewares, createBasicAuthMiddleware(app.appName, users));
    }
    if (Object.keys(middlewares).length > 0 && config.http) {
      config.http.middlewares = {
        ...config.http.middlewares,
        ...middlewares,
      };
    }

    // H-38. Every guard above holds a stored value to a rule Cloudgate
    // wrote. None of them can say whether *Traefik* accepts the file — and when
    // it does not, it drops the router, serves the Application's host through
    // the catch-all, and says so only to its own log. The anchor is read here
    // rather than inside the check because it must be older than the write: it
    // is the timestamp of the last line Traefik had already logged, and it is
    // what makes an error from a previous config impossible to attribute to
    // this one. The check itself is not awaited — a redirect edit must not wait
    // on a file-provider watcher — and cannot fail this method: it is an
    // observation of a write that has already happened, not a gate on one.
    const anchor = await this.status.anchor(app.serverId);
    await this.onServer(app.serverId, () =>
      this.writer.writeConfig(app.appName, config, app.serverId),
    );
    this.status.verifyInBackground(
      {
        applicationId: app.applicationId,
        appName: app.appName,
        serverId: app.serverId,
        routers: buildRouterSubjectIndex(app.appName, config, {
          domains,
          redirects,
          security: securityRows,
        }),
        // The htpasswd entries this file just emitted. Traefik quotes the
        // offending one back verbatim when it refuses it, and a basic-auth
        // password never leaves the server (`SecurityService`).
        secrets: users,
      },
      anchor,
    );
  }

  /**
   * Rewrites the file-provider config that routes a `stack` Compose's Domains,
   * or removes it when none is left to route — the Compose half of
   * {@link regenerate}, called by `DomainsService` at the same three points
   * (create, update, remove).
   *
   * The config comes from `createComposeStackTraefikConfig`, which the deploy
   * script also writes from (`getBuildComposeCommand`), so a Domain edit and a
   * deploy put the same bytes in `dynamic/compose+<appName>.yml` on the
   * stack's Server. Every Domain row is held to the same stored-value rule
   * `regenerate` holds an Application's to, because this file interpolates the
   * same columns into the same `Host()` rule. A row with no `serviceName` names
   * no backend and is left out, as the deploy's injector leaves it out.
   *
   * No `verifyInBackground`: that check records its verdict against an
   * `applicationId`, and a Compose has none — the reason `routePreview` gives.
   */
  async routeComposeStack(
    stack: TraefikComposeStackRef,
    db: DrizzleDB | DrizzleTx = this.db,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(domain)
      .where(eq(domain.composeId, stack.composeId));
    for (const row of rows) {
      this.assertStoredValuesSafe(storedDomainRoutingSchema, row, {
        noun: 'Domain',
        id: row.domainId,
      });
    }

    const configName = composeStackConfigName(stack.appName);
    const routed = rows.flatMap((row) =>
      row.serviceName ? [{ ...row, serviceName: row.serviceName }] : [],
    );
    if (routed.length === 0) {
      await this.onServer(stack.serverId, () =>
        this.writer.removeConfig(configName, stack.serverId),
      );
      return;
    }
    await this.onServer(stack.serverId, () =>
      this.writer.writeConfig(
        configName,
        createComposeStackTraefikConfig(stack.appName, routed),
        stack.serverId,
      ),
    );
  }

  /**
   * Rewrites the file-provider config that routes a bucket's Domains to its
   * Garage S3 API, or removes it when none is left — the bucket half
   * of {@link regenerate}, called by `DomainsService` at the same three
   * points. The file is `dynamic/<appName>.yml` as an Application's is, and
   * its routers forward to the bucket's Swarm service by `appName` with the
   * Host header passed on, which is what Garage checks a signature against.
   * A bucket has no redirects and no basic-auth users: an S3 client signs
   * every request itself.
   *
   * No `verifyInBackground`: that check records its verdict against an
   * `applicationId`, and a bucket has none — the reason `routeComposeStack`
   * gives.
   */
  async routeBucket(
    store: TraefikBucketRef,
    db: DrizzleDB | DrizzleTx = this.db,
  ): Promise<void> {
    const rows = await db
      .select()
      .from(domain)
      .where(eq(domain.bucketId, store.bucketId));
    for (const row of rows) {
      this.assertStoredValuesSafe(storedDomainRoutingSchema, row, {
        noun: 'Domain',
        id: row.domainId,
      });
    }
    if (rows.length === 0) {
      await this.onServer(store.serverId, () =>
        this.writer.removeConfig(store.appName, store.serverId),
      );
      return;
    }
    await this.onServer(store.serverId, () =>
      this.writer.writeConfig(
        store.appName,
        createTraefikConfig(
          { appName: store.appName, redirects: [], security: [] },
          rows,
        ),
        store.serverId,
      ),
    );
  }

  /**
   * One write to a Server's Traefik file, with a Server that was never reached
   * answered as the 503 `HOST_UNREACHABLE` every other route gives it, rather
   * than as the raw SSH error the writer throws — which the exception filter
   * can only answer as a 500 (#1417). A write that reached the machine and
   * failed there is not a reachability fact and propagates as it was.
   *
   * At the writer's three callers here rather than at each Service that calls
   * them, because the fact is about this write: a Domain, a redirect and a
   * basic-auth user all reach a Server only through these methods. A create
   * or an edit answers this 503 as it is; a delete turns it into its own 409
   * and force (`routing-delete.ts`), which needs it typed rather than raw.
   */
  private async onServer(
    serverId: string | null,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      rethrowIfHostUnreachable(this.logger, serverId, error);
      throw error;
    }
  }

  /**
   * Whether the Application runs in a Cloud account, read off its stored row.
   * A row that is gone answers `false`: the writer still refuses a `null`
   * place on the Hosted instance.
   */
  private async inCloud(
    applicationId: string,
    db: DrizzleDB | DrizzleTx,
  ): Promise<boolean> {
    const [row] = await db
      .select({ cloudAccountId: application.cloudAccountId })
      .from(application)
      .where(eq(application.applicationId, applicationId))
      .limit(1);
    return Boolean(row?.cloudAccountId);
  }

  /**
   * The htpasswd entries for an Application's basic-auth users, or none.
   *
   * Traefik's basicAuth verifies htpasswd-style entries, so the decrypted
   * passwords are bcrypt-hashed here. Shared by {@link regenerate} and
   * {@link routePreview}, because a preview is put behind its parent's users
   * and one hashing of them is what keeps the two files agreeing.
   */
  private async basicAuthUsers(
    securityRows: { username: string; password: string }[],
  ): Promise<string[]> {
    return Promise.all(
      securityRows.map(
        async (row) => `${row.username}:${await hash(row.password, 10)}`,
      ),
    );
  }

  /**
   * Writes the dynamic config that puts one preview deployment on its host.
   * Internal — `PreviewDeploymentsService.deployPreview` calls it once
   * the preview's Swarm service has converged, and throws on to report a
   * preview that built but could not be routed; `reroutePreviews` calls it
   * again for each live preview when the parent's DNS-01 switch moves.
   *
   * **What was missing.** A preview built, converged and was announced on the
   * pull request at `http://{preview.domain}`, and that host answered 404:
   * no Domain row was created for it and nothing wrote a router, so Traefik
   * matched none. The preview was reachable only from inside
   * `cloudgate-network`.
   *
   * **The path an Application's own Domain takes, not a parallel one.** The
   * config comes from the same generators ({@link createPreviewTraefikConfig}
   * wraps `createTraefikConfig`) and goes through the same writer into
   * `dynamic/{appName}.yml` on the same machine — the run Server, whose
   * Traefik serves the Swarm service the preview is. The name is the
   * preview's own, so the file is its own: ADR-0021 says a preview owns its
   * Traefik router, and `previewTeardownSteps` removes it by the same name.
   *
   * **Not a `domain` row, deliberately.** One would have to hang off the
   * *parent* Application (`domain_exactly_one_parent` allows no third
   * parent), so `regenerate(parent)` would emit it into the parent's file,
   * pointed at the parent's `appName` — the production service, not the
   * preview — and the parent's Domains screen would list and let an operator
   * edit a host the pull request owns.
   *
   * **The parent's basic-auth users, because a preview borrows the parent's
   * rows** (ADR-0021). `TraefikApp.security` is Application-level in the
   * generator — every router of an app gets `auth-{appName}` — and a preview
   * runs production's variables unless `previewEnv` says otherwise, so
   * an Application behind a password would otherwise be served without one on
   * every pull request's host. Its redirects are not carried: they are
   * per-Domain regexes the generator already keeps off a `'preview'` route.
   *
   * No `verifyInBackground`: that check records its verdict against an
   * `applicationId`, and a preview has none of its own — recording it against
   * the parent's would overwrite the parent's own Traefik status with the
   * preview's.
   */
  async routePreview(preview: TraefikPreviewRef): Promise<void> {
    // A cloud parent's `serverId` is `null`, which would put the preview's
    // router in the platform host's Traefik ({@link regenerate}'s reason).
    if (await this.inCloud(preview.parent.applicationId, this.db)) {
      throw new ConflictException(CLOUD_PREVIEW_NOT_ROUTED);
    }
    this.assertStoredValuesSafe(
      storedPreviewHostSchema,
      { host: preview.host },
      { noun: 'Preview deployment', id: preview.appName },
    );

    const securityRows = await this.db
      .select()
      .from(security)
      .where(eq(security.applicationId, preview.parent.applicationId));
    for (const row of securityRows) {
      this.assertStoredValuesSafe(storedSecurityUserSchema, row, {
        noun: 'Basic-auth user',
        id: row.securityId,
      });
    }

    const config = createPreviewTraefikConfig(
      { appName: preview.appName, redirects: [], security: securityRows },
      previewRoute(preview.host, preview.port),
      preview.dnsChallengeWildcard,
    );
    const users = await this.basicAuthUsers(securityRows);
    if (users.length > 0 && config.http) {
      config.http.middlewares = createBasicAuthMiddleware(
        preview.appName,
        users,
      );
    }

    await this.writer.writeConfig(
      preview.appName,
      config,
      preview.parent.serverId,
    );
  }

  /**
   * The auth domain the app's server gates through, if one is configured
   * **and is a hostname** (H-23).
   *
   * **The sink, and what a separator does to it.** `authDomain` is read from
   * storage here and interpolated raw into
   * ``address: `${scheme}://${authDomain}/oauth2/auth` ``
   * (`traefik/config/forward-auth.ts:41`). Traefik's forwardAuth then *dials*
   * that address and lets the request through on a 2xx, so the separators that
   * matter are the ones that move which host answers: `/` ends the authority
   * (`evil.example.com/` → `http://evil.example.com//oauth2/auth`), `#` starts
   * a fragment Go's `url.Parse` drops before dialling, `@` makes everything
   * before it userinfo, and `?` starts a query. Every one of them points the
   * gate at a server the operator did not choose — and a server that answers
   * 200 to everything turns the SSO gate into a pass-through. That is
   * materially worse than the H-14 family's forged *router*: this one forges
   * the *authorization decision*.
   *
   * **Which is why a bad value is treated as no gate rather than as a 400.**
   * Three shapes were weighed and this is the only one that is safe in every
   * direction:
   *
   * - **Throwing**, as the Domain, Redirect and basic-auth guards above do, is
   *   wrong *here* specifically because of what row this is. The local
   *   `forward_auth_settings` row is instance-wide and deliberately not
   *   organization-scoped (`forward-auth.schema.ts`) — one Traefik per Server,
   *   one row. A 400 would therefore stop **every organization's** next
   *   redirect, basic-auth or Domain edit on that Server because of a value
   *   only an enterprise owner/admin can correct. The other three guards throw
   *   because the poisoned row belongs to the caller; this one does not.
   * - **Emitting it anyway** is the live defect.
   * - **Dropping the gate**, which is this, removes the forged address from the
   *   file on the very next regeneration and **fails the gated Domain closed**:
   *   its routers still name `forward-auth-<app>-<key>`, that middleware is now
   *   undefined, and `router.go` skips a router whose chain it cannot build
   *   (the same mechanism the basic-auth guard documents). A gated Domain
   *   answers 404 rather than answering to whoever owns the injected host.
   *
   * That is not a new state either: this method already returns `null` for a
   * Server with no auth domain at all, and `regenerate`'s `gated` branch has
   * always been documented as silently emitting no middleware for it. What is
   * new is that it is no longer silent — an operator gets a log line naming the
   * row, which is the half the pre-existing behaviour was missing.
   *
   * `hostSchema` rather than a rule of this file's own (§2.4). It is the
   * repo's hostname rule and it is strictly wider than
   * `forward-auth/dto/forward-auth.dto.ts`'s `domainRegex` — that one is
   * lowercase-only with an alphabetic TLD, both of which `VALID_HOSTNAME_REGEX`
   * also accepts — so nothing this refuses could have been written through the
   * DTO. Only a row that predates the rule, or one written around it, can trip
   * this.
   */
  private async findAuthGate(serverId: string | null) {
    const [row] = await this.db
      .select({
        authDomain: forwardAuthSettings.authDomain,
        https: forwardAuthSettings.https,
      })
      .from(forwardAuthSettings)
      .where(
        serverId
          ? eq(forwardAuthSettings.serverId, serverId)
          : isNull(forwardAuthSettings.serverId),
      )
      .limit(1);
    if (!row) return null;

    const checked = hostSchema.safeParse(row.authDomain);
    if (!checked.success) {
      this.logger.error(
        `The forward-auth settings for ${serverId ?? 'the platform host'} carry a stored auth domain that is not a hostname, so no forward-auth middleware was written and every gated Domain on this Server will stop routing. Set the authentication domain again to restore it.`,
      );
      return null;
    }
    // The parsed value, not the row's: `hostSchema` trims, and the emitted
    // address should carry what the rule accepted rather than what was stored.
    return { authDomain: checked.data, https: row.https };
  }
}
