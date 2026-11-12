import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { notRetired } from '../bought-servers/retired-servers';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  channelRelations,
  custom,
  discord,
  email,
  gotify,
  lark,
  mattermost,
  notification,
  ntfy,
  pushover,
  resend,
  server,
  slack,
  teams,
  telegram,
} from '../db/schema';
import type {
  CustomConnection,
  DiscordConnection,
  EmailConnection,
  GotifyConnection,
  LarkConnection,
  MattermostConnection,
  Notification,
  NotificationType,
  NotificationWithChannels,
  NtfyConnection,
  PushoverConnection,
  ResendConnection,
  SlackConnection,
  TeamsConnection,
  TelegramConnection,
} from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type { MetricsConfig } from '../servers/server.schema';
import { deliveryFailureMessage } from './channels/channel-failure';
import { isOutboundAddressRefusal } from '../outbound/outbound-address-guard';
import { NotificationChannelRegistry } from './channels/channel-registry';
import { NotificationDispatcherService } from './dispatcher.service';
import type {
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
  ReceiveServerThresholdDto,
} from './dto/notification.dto';

/**
 * Whether a metrics config's stored token is the one an agent presented — the
 * whole of `POST /notifications/receive`'s authentication, so it is one
 * function and both branches of {@link NotificationsService.receiveServerThreshold}
 * call it (§1.4).
 *
 * **An empty stored token authenticates nobody.** `defaultMetricsConfig` sets
 * `token: ''` and that is what "never set up" means to
 * `MonitoringService.registerTarget`, while `ReceiveServerThresholdDto.Token`
 * is a bare `z.string()`. The remote branch used to ask SQL
 * `metrics_config -> 'server' ->> 'token' = $1`, which for `Token: ''` matched
 * every un-set-up Server on the instance, took the first and dispatched into
 * its organization's channels — an unauthenticated caller writing arbitrary
 * alert text into a stranger's Slack. The local branch had always guarded it
 * (`if (!token || …)`); the two are now the same check rather than two checks
 * that disagreed.
 *
 * `timingSafeEqual` on `github-webhook.util.ts`' precedent, including its
 * length pre-check — the function throws on a length mismatch rather than
 * answering false, and a token's length is not the secret.
 */
function authenticatesMetricsAgent(
  config: MetricsConfig | null | undefined,
  presented: string,
): boolean {
  const stored = config?.server?.token;
  if (!stored) return false;
  const expected = Buffer.from(stored, 'utf8');
  const received = Buffer.from(presented, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** Only the keys the caller actually sent — PATCH semantics. */
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** Everything but the named keys — the projection helper the strippers use. */
function omit<T extends object, K extends keyof T>(
  row: T,
  keys: readonly K[],
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}

/**
 * Which connection columns of each channel hold a credential.
 *
 * One list, two readers: `sanitize()` projects these away on the way out, and
 * `sendSavedTest` masks their values out of a refusal. They were two
 * lists for one commit and that is exactly how a credential escapes — a channel
 * added to the projection and forgotten in the redaction leaks on the one path
 * that carries provider text back.
 *
 * `custom.headers` is a column of its own here: a webhook authenticates
 * with `Authorization` or `X-API-Key`, so the map's *values* are as much a
 * credential as the endpoint. It is the one entry that is not a single string —
 * both readers take every value the map holds.
 */
const CREDENTIAL_COLUMNS = {
  slack: ['webhookUrl'],
  telegram: ['botToken'],
  discord: ['webhookUrl'],
  email: ['password'],
  resend: ['apiKey'],
  gotify: ['appToken'],
  ntfy: ['accessToken'],
  mattermost: ['webhookUrl'],
  custom: ['endpoint', 'headers'],
  lark: ['webhookUrl'],
  pushover: ['userKey', 'apiToken'],
  teams: ['webhookUrl'],
} as const satisfies Record<NotificationType, readonly string[]>;

const MASK = '••••••';

/**
 * The secret strings a credential column holds: one for the usual `text`
 * column, one per name for the custom channel's header map.
 */
function credentialStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    return Object.values(value).filter(
      (entry): entry is string => typeof entry === 'string',
    );
  }
  return [];
}

/**
 * Take a connection's credentials back out of a message about to be shown to a
 * person.
 *
 * Only the id-taking test needs this. On the credential-taking routes the
 * caller sent the secret and the console redacts its own copy out of the
 * refusal — the destinations precedent. Here the caller never held it, so
 * the server is the only place that can. The diagnosis is the whole reason the
 * refusal is shown, so only the credential *values* go; anything under six
 * characters is left alone, since it would eat unrelated words and a secret
 * that short is not a secret.
 */
function redactCredentials(
  message: string,
  type: NotificationType,
  connection: object,
): string {
  let out = message;
  for (const column of CREDENTIAL_COLUMNS[type]) {
    const value = (connection as Record<string, unknown>)[column];
    for (const secret of credentialStrings(value)) {
      if (secret.length < 6) continue;
      out = out.split(secret).join(MASK);
    }
  }
  return out;
}

/**
 * A notification as exposed over the API. Every channel connection column
 * holding a credential is an `encryptedText` (or, for the custom channel's
 * header map, an `encryptedJson`), which decrypts in `fromDriver` —
 * so a hydrated row carries the live secret and must be projected before it
 * leaves the server (the registry/destination `sanitize()` precedent). The
 * credential of each channel is dropped; everything the client renders (the
 * connection's id, target and formatting fields) stays.
 */
export type SanitizedNotification = Notification & {
  slack: Omit<SlackConnection, 'webhookUrl'> | null;
  telegram: Omit<TelegramConnection, 'botToken'> | null;
  discord: Omit<DiscordConnection, 'webhookUrl'> | null;
  email: Omit<EmailConnection, 'password'> | null;
  resend: Omit<ResendConnection, 'apiKey'> | null;
  gotify: Omit<GotifyConnection, 'appToken'> | null;
  /**
   * ntfy's access token is the one optional credential — dropping it leaves
   * the client unable to tell a tokenless public topic from a private one
   * whose token it must not see, so the projection answers with a boolean.
   */
  ntfy:
    (Omit<NtfyConnection, 'accessToken'> & { hasAccessToken: boolean }) | null;
  mattermost: Omit<MattermostConnection, 'webhookUrl'> | null;
  /**
   * The custom channel's headers are a free-form map, so there is no fixed key
   * to drop and no boolean that would answer "did I set the right one?" — the
   * projection reports the names alone. An operator sees that an
   * `Authorization` header is configured, `headerNames.length` is the count,
   * and no value crosses the wire.
   */
  custom:
    | (Omit<CustomConnection, 'endpoint' | 'headers'> & {
        headerNames: string[];
      })
    | null;
  lark: Omit<LarkConnection, 'webhookUrl'> | null;
  pushover: Omit<PushoverConnection, 'userKey' | 'apiToken'> | null;
  teams: Omit<TeamsConnection, 'webhookUrl'> | null;
};

function sanitize(row: NotificationWithChannels): SanitizedNotification {
  const {
    slack,
    telegram,
    discord,
    email,
    resend,
    gotify,
    ntfy,
    mattermost,
    custom,
    lark,
    pushover,
    teams,
    ...rest
  } = row;
  return {
    ...rest,
    slack: slack && omit(slack, CREDENTIAL_COLUMNS.slack),
    telegram: telegram && omit(telegram, CREDENTIAL_COLUMNS.telegram),
    discord: discord && omit(discord, CREDENTIAL_COLUMNS.discord),
    email: email && omit(email, CREDENTIAL_COLUMNS.email),
    resend: resend && omit(resend, CREDENTIAL_COLUMNS.resend),
    gotify: gotify && omit(gotify, CREDENTIAL_COLUMNS.gotify),
    ntfy: ntfy && {
      ...omit(ntfy, CREDENTIAL_COLUMNS.ntfy),
      hasAccessToken: ntfy.accessToken !== null,
    },
    mattermost: mattermost && omit(mattermost, CREDENTIAL_COLUMNS.mattermost),
    custom: custom && {
      ...omit(custom, CREDENTIAL_COLUMNS.custom),
      headerNames: Object.keys(custom.headers ?? {}),
    },
    lark: lark && omit(lark, CREDENTIAL_COLUMNS.lark),
    pushover: pushover && omit(pushover, CREDENTIAL_COLUMNS.pushover),
    teams: teams && omit(teams, CREDENTIAL_COLUMNS.teams),
  };
}

/** The event flags + name shared by every channel's create/update input. */
type CommonFields = Pick<
  NotificationWithChannels,
  | 'name'
  | 'appDeploy'
  | 'appBuildError'
  | 'databaseBackup'
  | 'volumeBackup'
  | 'instanceBackup'
  | 'instanceRestart'
  | 'dockerCleanup'
  | 'serverThreshold'
  | 'licenseLapse'
  | 'licenseExpiring'
  | 'agentRateLimited'
  | 'previewTeardownStuck'
  | 'serviceIncident'
  | 'aiModelNotAnswering'
>;

/** Each channel's connection table and its primary key, by notification type. */
const connectionTables = {
  slack: { table: slack, idColumn: slack.slackId },
  telegram: { table: telegram, idColumn: telegram.telegramId },
  discord: { table: discord, idColumn: discord.discordId },
  email: { table: email, idColumn: email.emailId },
  resend: { table: resend, idColumn: resend.resendId },
  gotify: { table: gotify, idColumn: gotify.gotifyId },
  ntfy: { table: ntfy, idColumn: ntfy.ntfyId },
  mattermost: { table: mattermost, idColumn: mattermost.mattermostId },
  custom: { table: custom, idColumn: custom.customId },
  lark: { table: lark, idColumn: lark.larkId },
  pushover: { table: pushover, idColumn: pushover.pushoverId },
  teams: { table: teams, idColumn: teams.teamsId },
} as const;

/**
 * Notification channels: one row in `notification` per configured channel,
 * the connection credentials in the channel's own table, both written in one
 * transaction.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly registry: NotificationChannelRegistry,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  /**
   * Push the hello probe through the channel's strategy against an unsaved
   * connection; delivery failure maps to a 400 carrying the transport's
   * message.
   */
  async sendTest(
    ctx: PermissionCtx,
    type: NotificationType,
    connection: unknown,
  ): Promise<void> {
    return this.deliverTest(
      ctx.session.activeOrganizationId,
      type,
      connection,
      (message) => message,
    );
  }

  /**
   * The same probe, against a channel that is already saved.
   *
   * `sendTest` takes the connection off the wire, which is the right way round
   * for a create — you prove a webhook before you save it. It is no use on a
   * saved channel: `sanitize()` keeps the credential on the server, so the
   * console has nothing to send, and "is the alerting I set up three months ago
   * still working?" was unanswerable. This loads the row exactly as
   * `NotificationDispatcherService.dispatch` does — hydrated with
   * `channelRelations`, credentials decrypted by `encryptedText` on the way out
   * of the driver — and pushes the hello probe through the same strategy.
   *
   * The credential never comes back: the route answers nothing on success, and
   * on a refusal the transport's message is masked (a webhook URL *is* the
   * credential, and a failed `fetch` names the URL it could not reach).
   */
  async sendSavedTest(
    ctx: PermissionCtx,
    notificationId: string,
  ): Promise<void> {
    const found = await this.findOneWithCredentials(ctx, notificationId);
    const type = found.notificationType;
    const connection = found[type];
    // Unreachable: the connection row is inserted in the same transaction as
    // the notification row and its FK cascades. Said anyway, because a test
    // that dispatched `undefined` would read as the channel being broken.
    if (!connection) {
      throw new NotFoundException('Notification connection not found');
    }
    return this.deliverTest(found.organizationId, type, connection, (message) =>
      redactCredentials(message, type, connection),
    );
  }

  /**
   * The shared probe: a failed delivery becomes a 400 carrying what the
   * transport actually said.
   *
   * **Through `deliveryFailureMessage` rather than `error.message`.** `fetch` rejects with a `TypeError` whose message is the literal
   * `fetch failed` whatever went wrong, and this read that message and nothing
   * else — so a host that does not resolve and a port that refuses the
   * connection produced the identical, causeless *"Did not work. Fetch
   * failed."*, and the operator could not tell whether to correct the hostname
   * or start the service. The reason was on the error's `cause` the whole time.
   * The helper walks that chain; the strategies compose the sentence around it.
   *
   * The bar is `DestinationsService.probeBucket`, which answers with rclone's
   * own words through `rcloneFailureMessage` — the transport's diagnosis rather
   * than a sentence this tree wrote about it.
   *
   * The `redact` pass is unchanged and still runs over whatever comes back: on
   * the saved-channel route a webhook URL *is* the credential and a failed
   * `fetch` names the URL it could not reach. What the `cause` adds is a host
   * and a port, never a URL path.
   */
  private async deliverTest(
    organizationId: string,
    type: NotificationType,
    connection: unknown,
    redact: (message: string) => string,
  ): Promise<void> {
    try {
      await this.registry.get(type, organizationId).send(connection as never, {
        type: 'test',
      });
    } catch (error) {
      // Already the 400 naming the field, and it carries no credential.
      if (isOutboundAddressRefusal(error)) throw error;
      throw new BadRequestException(
        redact(deliveryFailureMessage(error, 'Error testing the notification')),
      );
    }
  }

  /**
   * A metrics agent posts a threshold alert authenticated only by its server
   * token. The remote branch resolves the organization off the server row;
   * the local-instance (Cloudgate) branch checks the web-server settings
   * token and fans out instance-wide.
   *
   * **The remote branch matches in this process rather than in SQL, and has
   * to.** It used to be one `where` — `metrics_config -> 'server' ->> 'token' =
   * $1` — and `metricsConfig` is now `encryptedJson`, so the column holds
   * `enc:v1:…` and there is no `jsonb` to reach into. That is not an artefact
   * of encrypting the whole blob instead of the one field: AES-256-GCM under a
   * random IV encrypts the same plaintext to different bytes every time, so
   * **no** encrypted column can be looked up by value, and a `metricsToken` of
   * its own would have broken this `where` in exactly the same way.
   * `secret-bearing-columns.spec.ts` makes the same argument the other way
   * round, as the reason better-auth's `session.token` and `apikey.key` cannot
   * be encrypted at all: they are *only* ever looked up by value, and this
   * token has somewhere else to be compared.
   *
   * The scan is not new work. There is no index on `metrics_config` in any
   * migration, so the `where` was a sequential scan over `server` too; what
   * moved is a short AES-GCM decrypt and a `JSON.parse` per row, on a route
   * that fires when a threshold is breached. `find` also fixes a second thing
   * the `where` did quietly: it took the first of however many rows matched,
   * with no `limit` and no ordering, so two Servers sharing a token silently
   * resolved to whichever the planner returned.
   */
  async receiveServerThreshold(
    input: ReceiveServerThresholdDto,
  ): Promise<void> {
    if (input.ServerType !== 'Remote') {
      const settings = await this.db.query.webServerSettings.findFirst({
        orderBy: (row, { asc }) => [asc(row.createdAt)],
      });
      if (!authenticatesMetricsAgent(settings?.metricsConfig, input.Token)) {
        throw new BadRequestException('Token not found');
      }
      await this.dispatcher.dispatch(null, {
        type: 'server-threshold',
        serverName: 'Cloudgate',
        metric: input.Type,
        value: input.Value,
        threshold: input.Threshold,
        message: input.Message,
        timestamp: input.Timestamp,
      });
      return;
    }

    // Projected rather than `select()` (§2.6): these rows exist only to be
    // matched and to name an organization, and an unauthenticated route should
    // pull every Server's name, address and SSH key id off the instance for
    // neither. It does not save the decrypt — `metricsConfig` is the column
    // being compared, so every one of them is decrypted either way.
    const candidates = await this.db
      .select({
        organizationId: server.organizationId,
        metricsConfig: server.metricsConfig,
      })
      .from(server)
      // A Deleting or Deleted Bought Server's agent is not heard: its
      // threshold alerts stop with everything else that reaches it.
      .where(notRetired(this.db, server.serverId));
    const found = candidates.find((row) =>
      authenticatesMetricsAgent(row.metricsConfig, input.Token),
    );
    if (!found?.organizationId) {
      throw new BadRequestException('Token not found');
    }
    await this.dispatcher.dispatch(found.organizationId, {
      type: 'server-threshold',
      serverName: 'Remote',
      metric: input.Type,
      value: input.Value,
      threshold: input.Threshold,
      message: input.Message,
      timestamp: input.Timestamp,
    });
  }

  /** Create a slack channel in the active organization. */
  async createSlack(
    ctx: PermissionCtx,
    dto: CreateSlackDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, channel, ...common } = dto;
    return this.createChannel(ctx, 'slack', common, async (tx) => {
      const [row] = await tx
        .insert(slack)
        .values({ webhookUrl, channel })
        .returning();
      return { slackId: row.slackId };
    });
  }

  /** Create a telegram channel in the active organization. */
  async createTelegram(
    ctx: PermissionCtx,
    dto: CreateTelegramDto,
  ): Promise<SanitizedNotification> {
    const { botToken, chatId, messageThreadId, ...common } = dto;
    return this.createChannel(ctx, 'telegram', common, async (tx) => {
      const [row] = await tx
        .insert(telegram)
        .values({ botToken, chatId, messageThreadId })
        .returning();
      return { telegramId: row.telegramId };
    });
  }

  /** Create a discord channel in the active organization. */
  async createDiscord(
    ctx: PermissionCtx,
    dto: CreateDiscordDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, decoration, ...common } = dto;
    return this.createChannel(ctx, 'discord', common, async (tx) => {
      const [row] = await tx
        .insert(discord)
        .values({ webhookUrl, decoration })
        .returning();
      return { discordId: row.discordId };
    });
  }

  /** Create an email channel in the active organization. */
  async createEmail(
    ctx: PermissionCtx,
    dto: CreateEmailDto,
  ): Promise<SanitizedNotification> {
    const {
      smtpServer,
      smtpPort,
      username,
      password,
      fromAddress,
      toAddresses,
      ...common
    } = dto;
    return this.createChannel(ctx, 'email', common, async (tx) => {
      const [row] = await tx
        .insert(email)
        .values({
          smtpServer,
          smtpPort,
          username,
          password,
          fromAddress,
          toAddresses,
        })
        .returning();
      return { emailId: row.emailId };
    });
  }

  /** Create a resend channel in the active organization. */
  async createResend(
    ctx: PermissionCtx,
    dto: CreateResendDto,
  ): Promise<SanitizedNotification> {
    const { apiKey, fromAddress, toAddresses, ...common } = dto;
    return this.createChannel(ctx, 'resend', common, async (tx) => {
      const [row] = await tx
        .insert(resend)
        .values({ apiKey, fromAddress, toAddresses })
        .returning();
      return { resendId: row.resendId };
    });
  }

  /** Create a gotify channel in the active organization. */
  async createGotify(
    ctx: PermissionCtx,
    dto: CreateGotifyDto,
  ): Promise<SanitizedNotification> {
    const { serverUrl, appToken, priority, decoration, ...common } = dto;
    return this.createChannel(ctx, 'gotify', common, async (tx) => {
      const [row] = await tx
        .insert(gotify)
        .values({ serverUrl, appToken, priority, decoration })
        .returning();
      return { gotifyId: row.gotifyId };
    });
  }

  /** Create an ntfy channel in the active organization. */
  async createNtfy(
    ctx: PermissionCtx,
    dto: CreateNtfyDto,
  ): Promise<SanitizedNotification> {
    const { serverUrl, topic, accessToken, priority, ...common } = dto;
    return this.createChannel(ctx, 'ntfy', common, async (tx) => {
      const [row] = await tx
        .insert(ntfy)
        .values({
          serverUrl,
          topic,
          accessToken: accessToken ?? null,
          priority,
        })
        .returning();
      return { ntfyId: row.ntfyId };
    });
  }

  /** Create a mattermost channel in the active organization. */
  async createMattermost(
    ctx: PermissionCtx,
    dto: CreateMattermostDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, channel, username, ...common } = dto;
    return this.createChannel(ctx, 'mattermost', common, async (tx) => {
      const [row] = await tx
        .insert(mattermost)
        .values({ webhookUrl, channel, username })
        .returning();
      return { mattermostId: row.mattermostId };
    });
  }

  /** Create a custom channel in the active organization. */
  async createCustom(
    ctx: PermissionCtx,
    dto: CreateCustomDto,
  ): Promise<SanitizedNotification> {
    const { endpoint, headers, ...common } = dto;
    return this.createChannel(ctx, 'custom', common, async (tx) => {
      const [row] = await tx
        .insert(custom)
        .values({ endpoint, headers })
        .returning();
      return { customId: row.customId };
    });
  }

  /** Create a lark channel in the active organization. */
  async createLark(
    ctx: PermissionCtx,
    dto: CreateLarkDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, ...common } = dto;
    return this.createChannel(ctx, 'lark', common, async (tx) => {
      const [row] = await tx.insert(lark).values({ webhookUrl }).returning();
      return { larkId: row.larkId };
    });
  }

  /** Create a pushover channel in the active organization. */
  async createPushover(
    ctx: PermissionCtx,
    dto: CreatePushoverDto,
  ): Promise<SanitizedNotification> {
    const { userKey, apiToken, priority, retry, expire, ...common } = dto;
    return this.createChannel(ctx, 'pushover', common, async (tx) => {
      const [row] = await tx
        .insert(pushover)
        .values({ userKey, apiToken, priority, retry, expire })
        .returning();
      return { pushoverId: row.pushoverId };
    });
  }

  /** Create a teams channel in the active organization. */
  async createTeams(
    ctx: PermissionCtx,
    dto: CreateTeamsDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, ...common } = dto;
    return this.createChannel(ctx, 'teams', common, async (tx) => {
      const [row] = await tx.insert(teams).values({ webhookUrl }).returning();
      return { teamsId: row.teamsId };
    });
  }

  /** Patch a slack channel, org-scoped through findOne. */
  async updateSlack(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateSlackDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, channel, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'slack', common, {
      webhookUrl,
      channel,
    });
  }

  /** Patch a telegram channel, org-scoped through findOne. */
  async updateTelegram(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateTelegramDto,
  ): Promise<SanitizedNotification> {
    const { botToken, chatId, messageThreadId, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'telegram', common, {
      botToken,
      chatId,
      messageThreadId,
    });
  }

  /** Patch a discord channel, org-scoped through findOne. */
  async updateDiscord(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateDiscordDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, decoration, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'discord', common, {
      webhookUrl,
      decoration,
    });
  }

  /** Patch an email channel, org-scoped through findOne. */
  async updateEmail(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateEmailDto,
  ): Promise<SanitizedNotification> {
    const {
      smtpServer,
      smtpPort,
      username,
      password,
      fromAddress,
      toAddresses,
      ...common
    } = dto;
    return this.updateChannel(ctx, notificationId, 'email', common, {
      smtpServer,
      smtpPort,
      username,
      password,
      fromAddress,
      toAddresses,
    });
  }

  /** Patch a resend channel, org-scoped through findOne. */
  async updateResend(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateResendDto,
  ): Promise<SanitizedNotification> {
    const { apiKey, fromAddress, toAddresses, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'resend', common, {
      apiKey,
      fromAddress,
      toAddresses,
    });
  }

  /** Patch a gotify channel, org-scoped through findOne. */
  async updateGotify(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateGotifyDto,
  ): Promise<SanitizedNotification> {
    const { serverUrl, appToken, priority, decoration, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'gotify', common, {
      serverUrl,
      appToken,
      priority,
      decoration,
    });
  }

  /** Patch an ntfy channel, org-scoped through findOne. */
  async updateNtfy(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateNtfyDto,
  ): Promise<SanitizedNotification> {
    const { serverUrl, topic, accessToken, priority, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'ntfy', common, {
      serverUrl,
      topic,
      accessToken,
      priority,
    });
  }

  /** Patch a mattermost channel, org-scoped through findOne. */
  async updateMattermost(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateMattermostDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, channel, username, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'mattermost', common, {
      webhookUrl,
      channel,
      username,
    });
  }

  /** Patch a custom channel, org-scoped through findOne. */
  async updateCustom(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateCustomDto,
  ): Promise<SanitizedNotification> {
    const { endpoint, headers, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'custom', common, {
      endpoint,
      headers,
    });
  }

  /** Patch a lark channel, org-scoped through findOne. */
  async updateLark(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateLarkDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'lark', common, {
      webhookUrl,
    });
  }

  /** Patch a pushover channel, org-scoped through findOne. */
  async updatePushover(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdatePushoverDto,
  ): Promise<SanitizedNotification> {
    const { userKey, apiToken, priority, retry, expire, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'pushover', common, {
      userKey,
      apiToken,
      priority,
      retry,
      expire,
    });
  }

  /** Patch a teams channel, org-scoped through findOne. */
  async updateTeams(
    ctx: PermissionCtx,
    notificationId: string,
    dto: UpdateTeamsDto,
  ): Promise<SanitizedNotification> {
    const { webhookUrl, ...common } = dto;
    return this.updateChannel(ctx, notificationId, 'teams', common, {
      webhookUrl,
    });
  }

  /** One channel by id, org-scoped, with its credentials projected out. */
  async findOne(
    ctx: PermissionCtx,
    notificationId: string,
  ): Promise<SanitizedNotification> {
    return sanitize(await this.findOneWithCredentials(ctx, notificationId));
  }

  /**
   * The hydrated row including its decrypted connection credentials, for
   * internal use (the id-taking test). **Never returned from a
   * controller** — `findOne` is the read path and it projects. The
   * destination/AI `findOneWithCredentials` precedent.
   */
  private async findOneWithCredentials(
    ctx: PermissionCtx,
    notificationId: string,
  ): Promise<NotificationWithChannels> {
    const found = await this.db.query.notification.findFirst({
      where: and(
        eq(notification.notificationId, notificationId),
        eq(notification.organizationId, ctx.session.activeOrganizationId),
      ),
      with: channelRelations,
    });
    if (!found) throw new NotFoundException('Notification not found');
    return found;
  }

  /** The organization's channels, newest first. */
  async list(ctx: PermissionCtx): Promise<SanitizedNotification[]> {
    const rows = await this.db.query.notification.findMany({
      where: eq(notification.organizationId, ctx.session.activeOrganizationId),
      with: channelRelations,
      orderBy: desc(notification.createdAt),
    });
    return rows.map(sanitize);
  }

  /**
   * Delete a channel. The delete targets the channel connection row, whose FK
   * cascades to the notification row, so no connection row is left orphaned.
   */
  async remove(
    ctx: PermissionCtx,
    notificationId: string,
  ): Promise<SanitizedNotification> {
    const found = await this.findOne(ctx, notificationId);
    const connection = connectionTables[found.notificationType];
    const connectionId = found[`${found.notificationType}Id`];
    if (connection && connectionId) {
      await this.db
        .delete(connection.table)
        .where(eq(connection.idColumn, connectionId));
    } else {
      await this.db
        .delete(notification)
        .where(eq(notification.notificationId, notificationId));
    }
    return found;
  }

  /**
   * The shared update core: patch the notification row's name/flags and the
   * channel connection row in one transaction, both PATCH-semantics (only
   * the fields the caller sent).
   */
  private async updateChannel(
    ctx: PermissionCtx,
    notificationId: string,
    type: NotificationType,
    common: Partial<CommonFields>,
    connectionFields: Record<string, unknown>,
  ): Promise<SanitizedNotification> {
    const current = await this.findOne(ctx, notificationId);
    const commonPatch = defined(common);
    const connectionPatch = defined(connectionFields);
    const connection = connectionTables[type];
    const connectionId = current[`${type}Id`];
    await this.db.transaction(async (tx) => {
      if (Object.keys(commonPatch).length > 0) {
        await tx
          .update(notification)
          .set(commonPatch)
          .where(eq(notification.notificationId, current.notificationId));
      }
      if (Object.keys(connectionPatch).length > 0 && connectionId) {
        await tx
          .update(connection.table)
          .set(connectionPatch)
          .where(eq(connection.idColumn, connectionId));
      }
    });
    return this.findOne(ctx, notificationId);
  }

  /**
   * The shared create core: insert the channel connection row, then the
   * notification row pointing at it, in one transaction.
   */
  private async createChannel(
    ctx: PermissionCtx,
    type: NotificationType,
    common: CommonFields,
    insertConnection: (
      tx: Parameters<Parameters<DrizzleDB['transaction']>[0]>[0],
    ) => Promise<Partial<Record<`${NotificationType}Id`, string>>>,
  ): Promise<SanitizedNotification> {
    const created = await this.db.transaction(async (tx) => {
      const fk = await insertConnection(tx);
      const [row] = await tx
        .insert(notification)
        .values({
          ...common,
          ...fk,
          notificationType: type,
          organizationId: ctx.session.activeOrganizationId,
        })
        .returning();
      return row;
    });
    return this.findOne(ctx, created.notificationId);
  }
}
