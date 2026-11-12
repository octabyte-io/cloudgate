import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, eq } from 'drizzle-orm';
import type { Env } from '../common/config/env.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { LicenseService } from '../enterprise/license/license.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import type { CertificateType } from '../domains/domain.schema';
import { sanitizeMetricsConfig } from '../servers/nested-server';
import type { SanitizedMetricsConfig } from '../servers/nested-server';
import {
  createWebServerConfig,
  GATEWAY_ROUTER,
  resolveGatewayUpstream,
  resolveConsoleUpstream,
} from '../traefik/config/web-server';
import { TraefikConfigStatusService } from '../traefik/config-status.service';
import {
  PLATFORM_OWNED,
  TraefikWriterService,
} from '../traefik/traefik-writer.service';
import { ConsoleOriginService } from './console-origin.service';
import type { ConsoleOriginTrust } from './console-origin.service';
import { consoleHostSchema } from './dto/settings.dto';
import { InstanceUrlService } from './instance-url.service';
import {
  defaultWhitelabelingConfig,
  webServerSettings,
  WebServerSettingsRow,
  WebServerSettingsUpdate,
  WhitelabelingConfig,
  WhitelabelingConfigPatch,
} from './settings.schema';
import { TraefikFilesService } from './traefik-files.service';

/** `http://127.0.0.1:3000`, `http://[::1]:3000`, `http://localhost:3000`. */
const LOOPBACK_UPSTREAM =
  /^https?:\/\/(127\.\d+\.\d+\.\d+|\[::1\]|localhost)(:|$)/;

export interface AssignDomainInput {
  host: string;
  certificateType: CertificateType;
  letsEncryptEmail?: string | null;
  https?: boolean;
}

/**
 * `SanitizedMetricsConfig` and the one function that produces it now live in
 * `servers/nested-server.ts`, beside the `MetricsConfig` they project.
 *
 * They moved when a fix closed the residue this docblock used to record. The
 * per-Server copy of `metricsConfig.server.token` was still returned whole by
 * the nested `server` relation on `GET /applications/:id`, `GET /compose/:id`
 * and every database service read — which a **base member** reaches — and one
 * projection now serves both that relation and this singleton, rather than the
 * singleton's copy being spelled here and the relation's spelled again
 * somewhere else. `GET /servers` and `GET /servers/:id` still answer with the
 * raw `token`: that is `server:read`, and the operator who may rotate a
 * Server's token may read it.
 */
export type { SanitizedMetricsConfig };

/**
 * The web server settings as exposed over the API. The singleton carries one
 * secret, and it does not leave the server.
 *
 * `metricsConfig.server.token` is an `encryptedJson` column that decrypts on
 * read and is a *live shared credential*: possession of it is the whole
 * of `POST /notifications/receive`'s authentication, and the copy on **this**
 * row authenticates `receiveServerThreshold`'s instance-wide branch —
 * `dispatch(null, …)`, every organization's channels rather than one. It sat
 * beside the instance SSH key this type was first written to strip, and
 * `GET /settings/web-server` is open to any authenticated member, so a plain
 * member of any organization could read the token and post arbitrary alert text
 * into every tenant's Slack. Encrypting the column said in as many words
 * that at-rest encryption is orthogonal to API exposure; this is the
 * API-exposure half.
 *
 * The row used to carry a second secret, `sshPrivateKey`, whose presence this
 * type reported as `hasSshPrivateKey`. The column is dropped: nothing
 * ever read it, and a private key stored for no consumer is a credential at
 * rest with no benefit.
 *
 * **One list, so the next secret on this row cannot be forgotten — and the
 * list is not this type.** The asymmetry was not that the token was missed
 * once; it is that `stripSshPrivateKey` was named for a single column, so there
 * was nowhere for a second secret to be declared.
 * {@link sanitizeWebServerSettings} is now the row's whole projection, and
 * `test/coding-standards/web-server-settings-projection.spec.ts` is what
 * *holds* it: that property derives the requirement from the schema — every
 * encrypted-at-rest column on this table, and every field of a declared blob
 * default whose name says it is a credential, must be withheld and replaced by
 * its presence — so a new secret goes red by name rather than being served.
 * ADR 0019 states the rule it asserts.
 *
 * **The compiler does not state that property, and this docblock used to claim
 * it did.** `Omit` *retains* every key it is not told to drop, the function
 * supplies those keys through `...rest`, and no excess-property check applies
 * to a spread of already-typed keys — so a new `apiKey` column would compile
 * here and pass straight through into the response. What the types do enforce
 * is narrower and still worth having: renaming or removing `metricsConfig` or
 * `metricsConfig.server.token` breaks the build, and no controller can answer
 * with the raw row, because every method that returns one returns this type.
 * The enumeration is the spec's job.
 */
export type SanitizedWebServerSettings = Omit<
  WebServerSettingsRow,
  'metricsConfig'
> & {
  metricsConfig: SanitizedMetricsConfig;
};

/**
 * Project every secret the singleton carries out of it, each replaced by its
 * presence at the depth it lived at (ADR 0019). The only way a controller may
 * answer with this row.
 *
 * Exported so that `test/coding-standards/web-server-settings-projection.spec.ts`
 * can assert the projection against the schema's own column list. That property
 * is the enumeration, not {@link SanitizedWebServerSettings} — see its docblock
 * for why the compiler cannot be it.
 */
export function sanitizeWebServerSettings(
  row: WebServerSettingsRow,
): SanitizedWebServerSettings {
  const { metricsConfig, ...rest } = row;
  return {
    ...rest,
    // The blob's own projection is shared with the nested `server` relation on
    // a service read — one function for the two copies of one shape,
    // because a projection spelled per-site is the projection that gets
    // forgotten at the next site, which is the earlier lesson.
    metricsConfig: sanitizeMetricsConfig(metricsConfig),
  };
}

/**
 * The settings row as `GET /settings/web-server` and `POST /settings/assign-domain`
 * answer with it: the sanitized row, plus whether a browser on the console
 * domain will be let in. Derived on every read rather than stored — the
 * allowlist it reads changes without this row being written.
 */
export type WebServerSettingsView = SanitizedWebServerSettings & {
  consoleOrigin: ConsoleOriginTrust | null;
  /**
   * Whether the platform host's traefik.yml carries request metrics (ADR-0027)
   * — the platform host's half of "the Server read reports its request-metrics
   * state", read off the local file each time (`RequestMetricsService`). One
   * boolean that discloses no configuration, like `GET /settings/traefik/requests`.
   */
  requestMetricsEnabled: boolean;
};

/** The keys the caller actually sent — `undefined` means "leave it alone". */
function definedKeys<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Fold a partial branding write onto the stored config: absent keys keep their
 * value, explicit nulls clear it, and `errorPages` merges key-by-key rather
 * than being replaced wholesale.
 */
function mergeWhitelabelingConfig(
  current: WhitelabelingConfig,
  patch: WhitelabelingConfigPatch,
): WhitelabelingConfig {
  const { errorPages, ...top } = patch;
  return {
    ...current,
    ...definedKeys(top),
    errorPages: {
      ...current.errorPages,
      ...definedKeys(errorPages ?? {}),
    },
  };
}

/**
 * The `web_server_settings` singleton (created on first read) and the settings
 * mutations that only touch that row.
 */
@Injectable()
export class SettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly instanceUrl: InstanceUrlService,
    private readonly traefikWriter: TraefikWriterService,
    // The read-back half of the write below it: every write this service
    // makes to `dynamic/cloudgate.yml` is the console's own router file, and
    // `TraefikConfigStatusService.aroundConsoleWrite` is what turns it into an
    // observation of *this* write instead of whatever an Application's
    // regeneration last happened to see.
    private readonly configStatus: TraefikConfigStatusService,
    private readonly traefikFiles: TraefikFilesService,
    private readonly config: ConfigService<Env, true>,
    // LicenseModule is @Global, so the white-labeling gate can consult the
    // licence without SettingsModule importing it.
    private readonly license: LicenseService,
    private readonly consoleOrigin: ConsoleOriginService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The platform host's own Traefik configuration is instance-wide, so it takes
   * instance-level authority rather than the caller's role in whichever
   * organization they happen to be acting in (H-52).
   *
   * `dynamic/cloudgate.yml` — the console's own router file — has **two**
   * writers: {@link updateServerTraefik} below, reached through
   * {@link assignDomain}, and `TraefikFilesService.writeConfig('cloudgate', …)`
   * behind `POST /settings/traefik/web-server-config`, which takes raw operator
   * YAML. Both sat behind {@link requireOwnerOrAdmin}, which reads the caller's
   * member row in their *active* organization, so any organization's owner
   * could rewrite the console's router. The escape hatch is deliberate and
   * stays; who may reach it is what changed.
   *
   * {@link requireOwnerOrAdmin} is untouched and keeps its name — ADR-0010
   * cites it, and it is still the right question for a route that names a
   * Server, where an organization's owner administers its own fleet.
   * `PermissionService.checkInstanceAuthority` carries the reasoning and the
   * evidence that this cannot lock an operator out.
   */
  requireInstanceAuthority(ctx: PermissionCtx): Promise<void> {
    return this.permissions.checkInstanceAuthority(ctx);
  }

  /** Only owner/admin members of the caller's active organization pass. */
  async requireOwnerOrAdmin(ctx: PermissionCtx): Promise<void> {
    const member = await this.permissions.findMember(ctx);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage web server settings',
      );
    }
  }

  /**
   * The singleton row as the API may answer with it — both of its secrets
   * projected out and each replaced by its presence, per
   * {@link SanitizedWebServerSettings}. This is what controllers return.
   */
  async getSanitizedWebServerSettings(): Promise<SanitizedWebServerSettings> {
    return sanitizeWebServerSettings(await this.getWebServerSettings());
  }

  /**
   * The sanitized row plus the console domain's origin and whether it is
   * trusted — what the Settings → Instance screen renders from. Open to
   * any authenticated caller like the row itself: the flag says whether one
   * origin is on the list, never what else is.
   */
  async getWebServerSettingsView(): Promise<WebServerSettingsView> {
    return this.toView(await this.getWebServerSettings());
  }

  private async toView(
    row: WebServerSettingsRow,
  ): Promise<WebServerSettingsView> {
    return {
      ...sanitizeWebServerSettings(row),
      consoleOrigin: await this.consoleOrigin.trustOf(row),
      requestMetricsEnabled: this.traefikFiles.platformCarriesRequestMetrics(),
    };
  }

  /**
   * The full singleton row *including its decrypted secret*, the metrics
   * agent token, for internal use — `AdminService.setupMonitoring` reads the
   * stored token to keep it when a write omits it. (`NotificationsService`
   * reads the row itself to check an inbound token, and compares it in the
   * process because an `encryptedJson` column cannot be queried by value.) Never
   * return this from a controller — use {@link getSanitizedWebServerSettings}.
   *
   * **The row's metrics type is a constant, and a stored row that says
   * otherwise is corrected in place.** This row is always the instance, so
   * `metricsConfig.server.type` is always `'Cloudgate'`; rows written before
   * that value was settled carry a different literal inside the encrypted
   * blob, which no SQL migration can reach. The first read rewrites it through
   * the column, once, and every read after that finds it already right.
   */
  async getWebServerSettings(): Promise<WebServerSettingsRow> {
    const settings = await this.db.query.webServerSettings.findFirst({
      orderBy: (row, { asc }) => [asc(row.createdAt)],
    });
    if (settings) {
      if (settings.metricsConfig.server.type === 'Cloudgate') return settings;
      const metricsConfig = {
        ...settings.metricsConfig,
        server: {
          ...settings.metricsConfig.server,
          type: 'Cloudgate' as const,
        },
      };
      const [corrected] = await this.db
        .update(webServerSettings)
        .set({ metricsConfig })
        .where(eq(webServerSettings.id, settings.id))
        .returning();
      return corrected;
    }

    const [created] = await this.db
      .insert(webServerSettings)
      .values({})
      .returning();
    return created;
  }

  /**
   * Write the singleton and return the full row *including* its decrypted
   * secret, the metrics agent token. Never
   * return this from a controller: project it through
   * {@link sanitizeWebServerSettings} first.
   */
  async updateWebServerSettings(
    updates: WebServerSettingsUpdate,
  ): Promise<WebServerSettingsRow> {
    const current = await this.getWebServerSettings();

    const [updated] = await this.db
      .update(webServerSettings)
      .set({ ...updates, updatedAt: new Date().toISOString() })
      .where(eq(webServerSettings.id, current.id))
      .returning();
    return updated;
  }

  /** The instance's URL; null while no host or serverIp is configured. */
  getInstanceUrl(): Promise<string | null> {
    return this.instanceUrl.getInstanceUrl();
  }

  /** The stored server IP, or `''` if none is set (any authenticated user). */
  async getIp(): Promise<string> {
    const settings = await this.getWebServerSettings();
    return settings.serverIp || '';
  }

  /**
   * Sets the platform host's IP. Answers with the sanitized row: this is a
   * controller return, and the singleton carries the metrics agent token
   * (the instance SSH key once rode this answer, before it was dropped).
   */
  async updateServerIp(
    ctx: PermissionCtx,
    serverIp: string,
  ): Promise<SanitizedWebServerSettings> {
    // The platform host's own address on the settings singleton, and what
    // `getInstanceUrl` builds every callback and notification link out of when
    // no host is set — so instance authority, with the rest of that row (H-63).
    // `GET /settings/ip` stays any-authenticated: it is a value the console
    // shows on its own setup screen.
    await this.requireInstanceAuthority(ctx);
    return sanitizeWebServerSettings(
      await this.updateWebServerSettings({ serverIp }),
    );
  }

  /**
   * Switches SSO-only sign-in on or off for the whole instance. The licence is
   * not checked here: a licence gate would let a lapsed licence strand an
   * instance in SSO-only mode with no way to switch back.
   *
   * **Instance authority, and this was the sharpest of the two writes
   * that batch moved.** `enforceSSO` is one boolean on the settings singleton
   * and `SsoService.enforceSso` reads it with no organization in the query, so
   * it is instance-wide by construction — while the gate was
   * {@link requireOwnerOrAdmin}, which reads the caller's member row in the
   * organization they are *currently acting in*. So an owner or admin of any
   * second Organization could take password sign-in away from every
   * Organization on the instance, or hand it back after an operator had
   * deliberately removed it. That is ADR-0010's fourth consequence and
   * ADR-0013's H-51 shape, on the **login path** rather than on a Traefik file:
   * the console's own `EnforceCard` calls this control *"the most dangerous in
   * the console and it is not close"*, because F06's sign-in screen renders no
   * password form at all while it is on.
   *
   * Nothing else about the route changed. There is still no licence check, and
   * the reason above is why that is not an oversight to be tidied up on the way
   * past: the *off* direction is the recovery path, so a gate that can lapse is
   * a gate that can lock an instance out of itself. Contrast
   * {@link updateWhitelabelingConfig}, where the licence genuinely gates the
   * feature and lapsing only stops further rebranding.
   */
  async updateEnforceSso(
    ctx: PermissionCtx,
    enforceSSO: boolean,
  ): Promise<void> {
    await this.requireInstanceAuthority(ctx);
    await this.updateWebServerSettings({ enforceSSO });
  }

  /**
   * The instance's branding. Public: the sign-in screen is the
   * first place a white-labelled instance has to look right and it is reached
   * with no session — `GET /sso/show-sign-in` is the precedent.
   *
   * Selects the branding column and nothing else, so no other field of the
   * singleton — the metrics agent token above all — can ride out on an
   * unauthenticated response. It also does not *create* the singleton the way
   * {@link getWebServerSettings} does: an anonymous request must not write.
   */
  async getWhitelabelingConfig(): Promise<WhitelabelingConfig> {
    const [row] = await this.db
      .select({ whitelabelingConfig: webServerSettings.whitelabelingConfig })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    return row?.whitelabelingConfig ?? defaultWhitelabelingConfig;
  }

  /**
   * Rebrand the instance. A *merge*: a key the caller omitted keeps
   * its stored value, an explicit null clears it. Branding is edited one field
   * at a time on a form, and a whole-blob replace would have every save wipe
   * whatever another field had set.
   *
   * **Two gates, asked in this order, and deliberately not one method.**
   * `whitelabelingConfig` is one `jsonb` column on the `web_server_settings`
   * singleton — one row, whole instance — so an owner or admin of any second,
   * licensed Organization used to write the app name, logo, favicon, colours,
   * CSS and error-page copy that every *other* Organization's members and every
   * anonymous visitor to the sign-in page render. The gate was a private
   * `ensureEnterprise` that bundled the two questions and asked **both** of the
   * caller's own active Organization, which is ADR-0013's H-51 shape; that
   * bundling is also why the defect read as a licence check and survived a
   * review.
   *
   * They are separate answers and they are kept separate. A caller refused for
   * authority is not the same as one refused for licence — the first is "this is
   * not yours to configure", the second is "this instance has not bought the
   * feature" — and an operator debugging the second must not be shown the
   * first's sentence. Re-bundling them into one `ensureInstanceEnterprise` was
   * the shorter diff and was rejected for that.
   *
   * Authority is asked **first**, and the order is load-bearing rather than
   * stylistic: whether this instance holds an enterprise licence is not a fact
   * a second Organization's owner is owed, and `checkInstanceAuthority`'s own
   * refusal is written once precisely so a refused caller learns nothing about
   * the instance's shape.
   *
   * The read is untouched and stays `@Public()` — see
   * {@link getWhitelabelingConfig}. ADR-0013's *"the white-labeling split
   * (public read, licensed write) is not a precedent"* was about that read; the
   * write was never argued until later.
   */
  async updateWhitelabelingConfig(
    ctx: PermissionCtx,
    patch: WhitelabelingConfigPatch,
  ): Promise<WhitelabelingConfig> {
    await this.requireInstanceAuthority(ctx);
    await this.requireInstanceLicense();
    const current = await this.getWebServerSettings();
    const updated = await this.updateWebServerSettings({
      whitelabelingConfig: mergeWhitelabelingConfig(
        current.whitelabelingConfig,
        patch,
      ),
    });
    return updated.whitelabelingConfig;
  }

  /**
   * Is *this instance* licensed for an instance-wide enterprise feature — the
   * licence half of {@link updateWhitelabelingConfig}'s gate, and nothing about
   * who is asking. It takes no `PermissionCtx` for that reason: the subject of
   * this question is the instance, and a method that accepted a caller would
   * invite the mistake this was written to fix.
   *
   * **Whose licence, decided in ADR-0013: the instance organization's.**
   * `SsoService.ensureEnterprise` and `CustomRolesService.ensureEnterprise` ask
   * `LicenseService.hasValidLicense(ctx.session.activeOrganizationId)` and are
   * right to — an `sso_provider` and a custom role are `organizationId`-scoped
   * rows, so the Organization that pays is the Organization that gets the
   * feature. This column is not: it is on the singleton, and *"any
   * Organization's licence unlocks a switch that reaches every Organization"* is
   * the same cross-tenant defect one level above the one closed here. The
   * Organization that owns the instance-level surface in ADR-0013's own terms is
   * the instance organization, so it is the Organization whose licence gates it.
   *
   * `LicenseService.hasAnyValidLicense` was the alternative already in the tree
   * and was rejected as *that* defect: it is exactly "any Organization's
   * licence". It is not a counter-precedent either — it was written (phase 49,
   * `SsoService.showSignInWithSso`) when ADR-0010's ceiling still said *"there
   * is no instance-level authority in this codebase to gate on"*, and its own
   * docblock records that it approximates the *instance owner's* licence row.
   * So it is that subject with no way to name it; ADR-0013 gave it one, and
   * this asks about that row by name. Its two existing callers are reads and a
   * capability resolver rather than an authorization gate, and they are
   * deliberately left alone here.
   *
   * The instance organization is resolved through
   * `PermissionService.instanceOrganizationId` rather than re-derived, and that
   * method's docblock carries why the composition sits on this side of the two
   * services.
   *
   * **On the Hosted instance it is not asked at all (ADR-0048):**
   * install-wide settings are Octabyte's and never sold, so hosted mode
   * unlocks them, and `hasValidLicense` there means "is this Organization
   * Enterprise", which is a customer's question, not the instance's. Instance
   * authority still decides who may make the change.
   */
  private async requireInstanceLicense(): Promise<void> {
    if (this.instanceMode.isHosted) return;
    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    const licensed =
      instanceOrganizationId !== null &&
      (await this.license.hasValidLicense(instanceOrganizationId));
    if (!licensed) {
      throw new ForbiddenException('Valid enterprise license required');
    }
  }

  /**
   * Sets how many builds the platform host runs at once, across every
   * organization's queue partitions. Instance authority (H-63) — setting it to
   * 1 is a throttle one organization would otherwise apply to all the others.
   */
  async updateBuildsConcurrency(
    ctx: PermissionCtx,
    buildsConcurrency: number,
  ): Promise<void> {
    await this.requireInstanceAuthority(ctx);
    await this.updateWebServerSettings({ buildsConcurrency });
  }

  /**
   * Sets the Cloud run pool limit: how many `tofu` runs the platform
   * host runs at once, install-wide. Instance authority like Concurrent
   * builds, for the same reason — and the same licence rule applies when the
   * pool reads it (`cloud-runs-concurrency.provider.ts`).
   */
  async updateCloudRunsConcurrency(
    ctx: PermissionCtx,
    cloudRunsConcurrency: number,
  ): Promise<void> {
    await this.requireInstanceAuthority(ctx);
    await this.updateWebServerSettings({ cloudRunsConcurrency });
  }

  /**
   * Sets the Cloud run time limit in minutes: one limit for
   * deploy, network and Delete runs, read when each run starts.
   */
  async updateCloudRunTimeLimit(
    ctx: PermissionCtx,
    cloudRunTimeLimitMinutes: number,
  ): Promise<void> {
    await this.requireInstanceAuthority(ctx);
    await this.updateWebServerSettings({ cloudRunTimeLimitMinutes });
  }

  /**
   * Sets the instance maximum TTL of a Requested preview. The
   * same gate as Concurrent builds, for the same reason: it bounds what every
   * organization's previews may cost the machine. Read back by
   * `requested-preview-max-ttl.ts`.
   */
  async updateRequestedPreviewMaxTtl(
    ctx: PermissionCtx,
    requestedPreviewMaxTtlMinutes: number,
  ): Promise<void> {
    await this.requireInstanceAuthority(ctx);
    await this.updateWebServerSettings({ requestedPreviewMaxTtlMinutes });
  }

  /**
   * Persist the dashboard domain, rewrite the cloudgate Traefik config
   * (updateServerTraefik) and the acme email.
   *
   * `updateServerTraefik` needs the full row (https, certificateType), but the
   * answer is sanitized — this is a controller return and the singleton
   * carries the metrics agent token (the instance SSH key once rode
   * this answer, before it was dropped).
   *
   * The answer carries `consoleOrigin`: a save that produces a console
   * nobody can sign in to is still saved — the routers and the certificate are
   * right, and whether to trust the origin is the operator's call (see
   * `ConsoleOriginService`) — but it says so in the same response.
   */
  async assignDomain(
    ctx: PermissionCtx,
    input: AssignDomainInput,
  ): Promise<WebServerSettingsView> {
    // The console's host, its certificate and `dynamic/cloudgate.yml` — the
    // structured half of the pair `requireInstanceAuthority` describes.
    await this.requireInstanceAuthority(ctx);
    const settings = await this.updateWebServerSettings({
      host: input.host,
      letsEncryptEmail: input.letsEncryptEmail,
      certificateType: input.certificateType,
      https: input.https,
    });

    await this.updateServerTraefik(settings, input.host);
    if (input.letsEncryptEmail) {
      this.traefikFiles.updateLetsEncryptEmail(input.letsEncryptEmail);
    }
    return this.toView(settings);
  }

  /**
   * Merge the console's web routers, built by the Phase 19
   * createWebServerConfig generator, into the cloudgate config, or drop the
   * file when the host is cleared.
   *
   * **This owns the file named `cloudgate`** — `dynamic/cloudgate.yml`. Clearing
   * the console's host calls `removeConfig('cloudgate')`, which *deletes* that
   * file rather than emptying it, so a hand-written dynamic config must not be
   * given that name: assigning and then clearing a console domain would take it
   * with it.
   *
   * **The write is wrapped in `aroundConsoleWrite`**, which reads
   * Traefik's log for this file before and after it. Saving a console domain
   * used to leave the Console routing card reporting an observation taken at
   * whatever unrelated Application regeneration happened last — on the reported
   * box, 55 minutes old and presented as the verdict on a save three minutes
   * before. Clearing the host is wrapped too: a `removeConfig` is a write to the
   * file provider like any other, and the routers it takes away are exactly the
   * ones the card reports on.
   */
  /**
   * Overwrites one of the two raw-YAML Traefik files an operator may hand-edit,
   * observing what Traefik makes of the write.
   *
   * The wrap is `updateServerTraefik`'s, at the other writer of the same files:
   * `cloudgate` holds the console's own routers, and hand-written YAML
   * is the likeliest way to write a router Traefik refuses; a middleware
   * `middlewares` fails to build takes down every router that links to it, the
   * console's own included. It lives here rather than in the controller
   * because a handler resolves the caller's context and returns the service's
   * promise, and this is the orchestration that leaves (§2.2).
   *
   * The wrapper observes the write and never gates it. What does gate it is
   * `TraefikFilesService.writeConfig` itself, which refuses YAML the file
   * provider would drop with a 400 naming the parser's line, before anything
   * is written — so these routes answer 400 for that, and 200 for
   * everything they accepted before.
   */
  async writeRawTraefikConfig(
    file: 'cloudgate' | 'middlewares',
    traefikConfig: string,
  ): Promise<void> {
    await this.configStatus.aroundConsoleWrite(() => {
      this.traefikFiles.writeConfig(file, traefikConfig);
      return Promise.resolve();
    });
  }

  async updateServerTraefik(
    settings: WebServerSettingsRow | null,
    newHost: string | null,
  ): Promise<void> {
    const config = await this.traefikWriter.loadOrCreateConfig('cloudgate');

    await this.configStatus.aroundConsoleWrite(async () => {
      if (newHost) {
        const consoleUrl = this.resolveConsoleUpstream();
        const updated = createWebServerConfig(config, {
          host: newHost,
          https: settings?.https ?? false,
          certificateType: settings?.certificateType,
          consoleUrl,
          gatewayUrl: resolveGatewayUpstream(
            consoleUrl,
            this.config.get('PORT', { infer: true }),
          ),
        });
        await this.traefikWriter.writeConfig(
          'cloudgate',
          updated,
          null,
          PLATFORM_OWNED,
        );
      } else {
        await this.traefikWriter.removeConfig(
          'cloudgate',
          null,
          PLATFORM_OWNED,
        );
      }
    });
  }

  /**
   * Take a console host that is not a hostname back out of the file provider
   * (H-25).
   *
   * **The gap this closes is the mirror image of X05-1, and that is why
   * it needed a different mechanism.** There, a stored Domain outside the
   * charset was re-emitted by every write that regenerated its Application, so
   * a guard *at the emitter* was enough to stop it being maintained. Here
   * nothing re-emits at all: {@link updateServerTraefik} is the only writer of
   * `dynamic/cloudgate.yml`, {@link assignDomain} is its only caller, and both
   * take the host from `AssignDomainDto` rather than from the row. So a
   * ``Host(`console.example.com`) || Host(`victim.example.com`)`` written
   * before the host rule is not re-emitted — it is *never revisited*, and sits
   * in the file provider claiming whatever it claims until an admin happens to
   * run `assignDomain` again for unrelated reasons. An emitter guard cannot see
   * a value no emitter reads. Boot is the one moment this instance is guaranteed
   * to look at the row.
   *
   * **A default install must not become an error, which shapes the first two
   * lines.** X05-3 found `webServerSettings.host` empty on a stock box
   * with no `dynamic/cloudgate.yml` at all, and `assertHostUnclaimed`'s "an
   * unset console host reserves nothing" is a deliberate rule rather than an
   * accident. So *no singleton row* and *an empty host* both return without
   * touching anything, and `consoleHostSchema` — not `hostSchema` — is what
   * decides, because it is the schema that already knows `''` is how the
   * console domain is unassigned.
   *
   * **Removing the file, and clearing the column, rather than logging.** Three
   * remedies were weighed. Refusing to boot punishes the whole instance for one
   * bad column and takes the console offline in the one state where an operator
   * needs it to fix the column. Logging alone leaves the forged rule live and
   * assumes someone reads the log. What is left is to put the instance into the
   * state a default install is already in and that every reader already
   * handles: `removeConfig('cloudgate')` — the same call an operator's own
   * "clear the console domain" makes — then `host: null`, which is what a
   * box that never assigned one carries.
   *
   * The file goes first on purpose. If the process dies between the two steps,
   * what survives is a stored host with no router, which is the harmless half;
   * the reverse would leave the forged router with nothing left in the database
   * pointing at it.
   *
   * **Clearing the column is not incidental tidiness.** A poisoned host is not
   * inert while it is stored: `InstanceUrlService.getInstanceUrl` builds
   * `https://<host>` out of it for every notification's dashboard link, and
   * `DomainsService.assertHostUnclaimed` compares a tenant's claim against it —
   * so the console-host reservation is *reserving the poisoned
   * string*, which no legitimate claim can ever equal, leaving the console's
   * real hostname free for any organization to take. Both of those go back to
   * their documented empty behaviour the moment the column is empty.
   *
   * **What this deliberately does not do is guess.** It has no way to recover
   * what the operator meant, so it does not try to salvage a hostname out of
   * the stored string — the injected half is attacker-chosen, and a repaired
   * router is a router nobody decided on. Re-running `assignDomain` is the
   * remediation, and the log line says so.
   */
  async sweepConsoleHost(): Promise<void> {
    const [row] = await this.db
      .select({ id: webServerSettings.id, host: webServerSettings.host })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    // A plain select, not `getWebServerSettings`: that one *creates* the
    // singleton when it is missing, and a sweep must not be the thing that
    // writes a row into a database nothing has used yet.
    if (!row) return;

    const stored = row.host ?? '';
    if (consoleHostSchema.safeParse(stored).success) return;

    this.logger.error(
      'The stored console host is not a hostname, so the console router has been removed from the Traefik file provider and the host cleared. ' +
        'Assign the console domain again from Settings to restore it.',
    );
    await this.traefikWriter.removeConfig('cloudgate', null, PLATFORM_OWNED);
    await this.db
      .update(webServerSettings)
      .set({ host: null, updatedAt: new Date().toISOString() })
      .where(eq(webServerSettings.id, row.id));
  }

  /**
   * Boot-time console-host sweep, tolerant of an un-migrated database — the
   * `DockerCleanupService.onApplicationBootstrap` precedent. A sweep that
   * cannot run is a sweep that did not happen, never a boot that fails: the
   * poisoned router predates this process and refusing to start would take the
   * console down without removing it.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sweepConsoleHost();
    } catch (error) {
      this.logger.error('Console host sweep at boot failed', error as Error);
    }
    try {
      await this.reconcileGatewayRouters();
    } catch (error) {
      this.logger.error(
        'Writing the gateway routers at boot failed',
        error as Error,
      );
    }
  }

  /**
   * Writes the Gateway's routers beside the console's when a console domain
   * is assigned and `dynamic/cloudgate.yml` has none (ADR-0040).
   *
   * {@link updateServerTraefik} is the only writer of those routers and
   * {@link assignDomain} its only caller, so an install that assigned its
   * console domain before the Gateway existed would get no `/ai` route until
   * someone saved the domain again. Boot is the one moment this instance is
   * guaranteed to look. **Idempotent and narrow**: it writes only when the
   * Gateway's router is missing, so a file that already has one, hand-edited
   * or not, is left alone; and it runs after {@link sweepConsoleHost}, so a
   * host that sweep cleared is never written back.
   */
  async reconcileGatewayRouters(): Promise<void> {
    const [row] = await this.db
      .select()
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt))
      .limit(1);
    if (!row?.host || !consoleHostSchema.safeParse(row.host).success) return;
    const config = await this.traefikWriter.loadOrCreateConfig('cloudgate');
    if (config.http?.routers?.[GATEWAY_ROUTER]) return;
    await this.updateServerTraefik(row, row.host);
  }

  /**
   * The console's origin, as Traefik has to dial it from inside its container.
   *
   * Never `http://cloudgate:${PORT}` any more: that named a container which
   * only exists in the containerised deployment, on the API's port rather than
   * the console's, so every native install's `dynamic/cloudgate.yml` 502'd.
   * Resolution order is documented on `resolveConsoleUpstream`.
   */
  private resolveConsoleUpstream(): string {
    const upstream = resolveConsoleUpstream({
      CLOUDGATE_CONSOLE_URL: this.config.get('CLOUDGATE_CONSOLE_URL', {
        infer: true,
      }),
      CLOUDGATE_PUBLIC_HOST: this.config.get('CLOUDGATE_PUBLIC_HOST', {
        infer: true,
      }),
      CONSOLE_PORT: this.config.get('CONSOLE_PORT', { infer: true }),
      BETTER_AUTH_URL: this.config.get('BETTER_AUTH_URL', { infer: true }),
    });

    // Traefik runs in a container: a loopback upstream is Traefik itself, so
    // this is the "nothing in the environment names an address" case rather
    // than a working default. Say so where an operator will see it.
    if (LOOPBACK_UPSTREAM.test(upstream)) {
      this.logger.warn(
        `The console domain will be routed to ${upstream}, which Traefik cannot reach from its own container. ` +
          'Set CLOUDGATE_PUBLIC_HOST (or CLOUDGATE_CONSOLE_URL) in the backend environment.',
      );
    }

    return upstream;
  }
}
