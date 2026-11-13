import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DEVICE_LOGIN_KEY_DAYS, DEVICE_TOKEN_CODES } from 'api-schemas';
import type { DeviceCode, DeviceToken, DeviceTokenRequest } from 'api-schemas';
import { and, desc, eq, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { member } from '../organizations/organizations.schema';
import { callAuthApi } from './auth-api.util';
import { CLI_CLIENT_ID } from './auth.config';
import type { Auth } from './auth.config';
import { AUTH } from './auth.constants';
import { apikey, deviceCode, user } from './auth.schema';
import { banInForce } from './ban';

/** How long a person has to approve a code: the plugin's default. */
const DEVICE_CODE_LIFETIME_MS = 30 * 60 * 1000;
/** How long the CLI waits between polls: the plugin's default. */
const DEVICE_POLL_INTERVAL_MS = 5 * 1000;

/** The name a CLI login's key gets when the CLI names none. */
const DEFAULT_KEY_NAME = 'Cloudgate CLI';

/**
 * `cloudgate login`'s server half: the CLI asks for a code,
 * the person approves it in the console, and the polling CLI is handed a
 * **Personal key** ending {@link DEVICE_LOGIN_KEY_DAYS} days after login.
 *
 * better-auth's `deviceAuthorization` plugin keeps the codes and serves the
 * person's half (`/api/auth/device`, `/device/approve`, `/device/deny`). Its
 * CLI half is unrouted (`disabledPaths` in `auth.config.ts`) and served here,
 * for two reasons:
 *
 * - **No session.** The plugin's `/device/token` creates a better-auth session
 *   and hands its token to the CLI, which would make a CLI login an
 *   interactive session and add a credential kind. This mints a
 *   Personal key instead, the credential CI already uses.
 * - **No pre-bind.** The plugin's `/device/code` stores a `user_id` taken from
 *   an unauthenticated body. Here the request takes no fields at all, and a
 *   code is bound only when a signed-in person looks it up.
 *
 * The poll follows the plugin's own rules (the same table, the same order of
 * checks), answering RFC 8628's errors as 400s with a `code`.
 */
@Injectable()
export class DeviceLoginService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly auditLogs: AuditLogService,
  ) {}

  /**
   * A new code, written as the plugin's own `/device/code` writes it (its
   * fields, its user-code alphabet) but with no user, ever. Written here
   * rather than through `auth.api.deviceCode` in-process, which builds a
   * verification URL from better-auth's base URL that the CLI never uses
   * (it names `<instance>/device` itself) and fails without one.
   */
  async start(): Promise<DeviceCode> {
    const now = Date.now();
    // Codes nobody finished are dead weight; the plugin only removes one it is
    // polled for after it ends.
    await this.db
      .delete(deviceCode)
      .where(lt(deviceCode.expiresAt, new Date(now)));
    const [row] = await this.db
      .insert(deviceCode)
      .values({
        id: nanoid(),
        deviceCode: randomBytes(30).toString('base64url'),
        userCode: userCode(),
        userId: null,
        expiresAt: new Date(now + DEVICE_CODE_LIFETIME_MS),
        status: 'pending',
        pollingInterval: DEVICE_POLL_INTERVAL_MS,
        clientId: CLI_CLIENT_ID,
      })
      .returning();
    return {
      deviceCode: row.deviceCode,
      userCode: row.userCode,
      interval: DEVICE_POLL_INTERVAL_MS / 1000,
      expiresIn: DEVICE_CODE_LIFETIME_MS / 1000,
    };
  }

  async poll(
    request: DeviceTokenRequest,
    ip: string | undefined,
  ): Promise<DeviceToken> {
    const [row] = await this.db
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, request.deviceCode))
      .limit(1);
    if (!row || row.clientId !== CLI_CLIENT_ID) {
      throw refusal(
        'invalid',
        'The device code is not one this Instance issued',
      );
    }
    const now = new Date();
    if (
      row.lastPolledAt &&
      row.pollingInterval &&
      now.getTime() - row.lastPolledAt.getTime() < row.pollingInterval
    ) {
      throw refusal('slowDown', 'Polling too often; wait longer between polls');
    }
    await this.db
      .update(deviceCode)
      .set({ lastPolledAt: now })
      .where(eq(deviceCode.id, row.id));

    if (row.expiresAt < now) {
      await this.db.delete(deviceCode).where(eq(deviceCode.id, row.id));
      throw refusal('expired', 'The code has expired; start the login again');
    }
    if (row.status === 'pending') {
      throw refusal('pending', 'Waiting for the code to be approved');
    }
    if (row.status === 'denied') {
      await this.db.delete(deviceCode).where(eq(deviceCode.id, row.id));
      throw refusal('denied', 'The login was denied in the console');
    }

    // Consumed once: two polls racing for one approval get one key between
    // them, and the loser the same answer as a spent code.
    const [claimed] = await this.db
      .delete(deviceCode)
      .where(and(eq(deviceCode.id, row.id), eq(deviceCode.status, 'approved')))
      .returning();
    if (!claimed?.userId) {
      throw refusal(
        'invalid',
        'The device code is not one this Instance issued',
      );
    }
    return this.mintKey(claimed.userId, request, ip);
  }

  private async mintKey(
    userId: string,
    request: DeviceTokenRequest,
    ip: string | undefined,
  ): Promise<DeviceToken> {
    const [owner] = await this.db
      .select({
        kind: user.kind,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    // Banned between approving and the poll, or not a person at all.
    if (!owner || owner.kind !== 'human' || banInForce(owner)) {
      throw refusal('denied', 'This account cannot log in');
    }

    const name = request.name ?? DEFAULT_KEY_NAME;
    // A refusal from better-auth keeps its 4xx and code, not a bare 500.
    const created = await callAuthApi(() =>
      this.auth.api.createApiKey({
        body: { userId, name, expiresIn: DEVICE_LOGIN_KEY_DAYS * 24 * 60 * 60 },
      }),
    );
    const organizationId = await this.defaultOrganizationOf(userId);
    await this.auditLogs.audit(
      { userId, organizationId, ip },
      {
        action: 'create',
        resourceType: 'user',
        resourceId: created.id,
        resourceName: name,
      },
    );

    if (request.replaces) {
      await this.deleteReplaced(request.replaces, userId, organizationId, ip);
    }

    return {
      key: created.key,
      keyId: created.id,
      expiresAt: new Date(created.expiresAt!).toISOString(),
    };
  }

  /**
   * The key an earlier login on the same Instance holds, deleted once its
   * successor exists. Only the approving person's own key: naming
   * anyone else's deletes nothing, and says nothing about whether it exists.
   */
  private async deleteReplaced(
    keyId: string,
    userId: string,
    organizationId: string | undefined,
    ip: string | undefined,
  ): Promise<void> {
    const [deleted] = await this.db
      .delete(apikey)
      .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, userId)))
      .returning({ id: apikey.id, name: apikey.name });
    if (!deleted) return;
    await this.auditLogs.audit(
      { userId, organizationId, ip },
      {
        action: 'delete',
        resourceType: 'user',
        resourceId: deleted.id,
        resourceName: deleted.name ?? undefined,
      },
    );
  }

  private async defaultOrganizationOf(
    userId: string,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .orderBy(desc(member.isDefault), desc(member.createdAt))
      .limit(1);
    return row?.organizationId;
  }
}

/**
 * The plugin's user-code alphabet: no 0/O, 1/I. 32 letters, so a byte modulo
 * 32 is unbiased. Eight of them, 40 bits, live for {@link DEVICE_CODE_LIFETIME_MS}.
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function userCode(): string {
  return Array.from(
    randomBytes(8),
    (byte) => USER_CODE_ALPHABET[byte % 32],
  ).join('');
}

function refusal(
  which: keyof typeof DEVICE_TOKEN_CODES,
  message: string,
): BadRequestException {
  return new BadRequestException({ message, code: DEVICE_TOKEN_CODES[which] });
}
