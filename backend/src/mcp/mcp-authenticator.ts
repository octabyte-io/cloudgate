import { Inject, Injectable } from '@nestjs/common';
import { defaultKeyHasher } from '@better-auth/api-key';
import { desc, eq } from 'drizzle-orm';
import { apikey, user } from '../auth/auth.schema';
import { banInForce } from '../auth/ban';
import { isAgentUser } from '../auth/user-kind';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { member } from '../organizations/organizations.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { agentKeyExpired } from '../agents/agent-key';
import type { Connection, McpClientInfo } from './mcp-protocol';

/** The Agent a verified key belongs to, as the rest of the dispatcher sees it. */
export interface AgentCaller {
  readonly userId: string;
  readonly organizationId: string;
  /** Checked by the suspension step, not here: a suspended Agent still gets a row. */
  readonly suspended: boolean;
  readonly key: {
    readonly id: string;
    /** The key's visible first characters, as the console shows them. */
    readonly start: string | null;
    /** What the client last said about itself; self-reported. */
    readonly lastClient: McpClientInfo | null;
  };
  /** The one check's context: the Agent's user in its one Organization. */
  readonly ctx: PermissionCtx;
}

export type Authentication =
  /** No key, an unknown or revoked one, a disabled one. No audit row. */
  | { readonly kind: 'invalid' }
  /** A person's key. No audit row: a person's refusals are not recorded. */
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'expired';
      readonly agent: AgentCaller;
      readonly expiredAt: Date;
    }
  | { readonly kind: 'agent'; readonly agent: AgentCaller };

/**
 * Who an `Authorization: Bearer` key belongs to (ADR-0023).
 *
 * **Not `AuthService.validateRequest`**, which refuses every Agent key by
 * design (an Agent is refused on REST), reads only `x-api-key`, and turns a
 * banned owner into the REST surface's sentence rather than the suspension
 * refusal. **Not `verifyApiKey` either**: the key is hashed with the plugin's
 * exported `defaultKeyHasher` and looked up directly, as `apiKeyOwnerKind`
 * does, because verifying runs the plugin's usage claim and its expired-key
 * sweep, and an Agent key's expiry is Cloudgate's own
 * (`apikey.agent_expires_at`, which the plugin never reads). Matching the hash
 * *is* the secret check the plugin makes; nothing else in its verify applies to
 * an Agent key (`remaining` and its rate limit are null and off on every one,
 * `mintAgentKey`).
 */
@Injectable()
export class McpAuthenticator {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async authenticate(
    authorization: string | undefined,
    now: Date = new Date(),
  ): Promise<Authentication> {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1];
    if (!token) return { kind: 'invalid' };

    const [found] = await this.db
      .select({ key: apikey, owner: user })
      .from(apikey)
      .innerJoin(user, eq(user.id, apikey.referenceId))
      .where(eq(apikey.key, await defaultKeyHasher(token)))
      .limit(1);
    if (!found) return { kind: 'invalid' };
    if (!isAgentUser(found.owner)) return { kind: 'personal' };
    if (found.key.enabled === false) return { kind: 'invalid' };

    // An Agent has exactly one membership for life (ADR-0023); the order is
    // `resolveMember`'s, so a second row — which nothing writes — would resolve
    // the way the REST surface resolves it.
    const [membership] = await this.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, found.owner.id))
      .orderBy(desc(member.isDefault), desc(member.createdAt))
      .limit(1);
    if (!membership) return { kind: 'invalid' };

    const agent: AgentCaller = {
      userId: found.owner.id,
      organizationId: membership.organizationId,
      suspended: banInForce(found.owner),
      key: {
        id: found.key.id,
        start: found.key.start,
        lastClient:
          found.key.lastClientName !== null
            ? {
                name: found.key.lastClientName,
                version: found.key.lastClientVersion,
              }
            : null,
      },
      ctx: {
        user: { id: found.owner.id },
        session: { activeOrganizationId: membership.organizationId },
      },
    };

    // An Agent key always expires; one with no expiry at all was not minted
    // by `mintAgentKey` and is refused rather than treated as permanent.
    const expiresAt = found.key.agentExpiresAt ?? found.key.expiresAt;
    if (!expiresAt) return { kind: 'invalid' };
    if (agentKeyExpired(expiresAt, now)) {
      return { kind: 'expired', agent, expiredAt: expiresAt };
    }
    return { kind: 'agent', agent };
  }

  /**
   * Records that the key was used, and — when the request said who it is —
   * what the client reported and the revision it was served at. The
   * `last_*` columns are self-reported "last connected" data: written here,
   * read by no decision.
   */
  async touch(
    keyId: string,
    connection: Pick<Connection, 'revision' | 'client'> | null,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db
      .update(apikey)
      .set({
        lastRequest: now,
        ...(connection
          ? {
              lastConnectedAt: now,
              lastProtocolRevision: connection.revision,
              ...(connection.client
                ? {
                    lastClientName: clip(connection.client.name),
                    lastClientVersion: clip(connection.client.version),
                  }
                : {}),
            }
          : {}),
      })
      .where(eq(apikey.id, keyId));
  }
}

/** A self-reported string, bounded: a client can claim a name of any length. */
function clip(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(0, 200);
}
