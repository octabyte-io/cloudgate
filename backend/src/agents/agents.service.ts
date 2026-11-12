import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { banInForce } from '../auth/ban';
import { agentEmail } from '../auth/user-kind';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { apikey, auditLog, member, user } from '../db/schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { countRateLimited } from '../enterprise/audit-logs/rate-limit-refusals';
import { insertAgentMember } from '../rbac/member-role';
import {
  fullEntitlements,
  PermissionService,
} from '../rbac/permission.service';
import type {
  MemberEntitlements,
  PermissionCtx,
} from '../rbac/permission.service';
import type { AgentRole } from '../rbac/access-control';
import { normalizeEmail } from '../users/user-email';
import { agentKeyExpired, mintAgentKey } from './agent-key';
import type { AgentKeyExpiryDays } from './agent-key';
import type { CreateAgentDto } from './dto/agent.dto';

/** "Rate-limited N times in the last hour". */
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

/**
 * The reason Suspend writes on the Agent's ban. A reason of its own, so
 * a ban written by anything else — SCIM's `SCIM_DEACTIVATION_REASON` — never
 * reads as an operator's.
 */
export const AGENT_SUSPENSION_REASON = 'Suspended by an operator';

/**
 * An Agent's user id. Lower-case, because the id is also the local part of the
 * Agent's address and `user.email` is stored lower-cased (`normalizeEmail`);
 * an id that changed case on the way into the address would make the two
 * disagree about which Agent a row is.
 */
const agentId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 24);

/** One of an Agent's keys, as the listing shows it. */
export interface AgentKeySummary {
  id: string;
  /** The key's first characters, to tell keys apart. Never the key. */
  start: string | null;
  createdAt: Date;
  /** When the key last authenticated, from the plugin's own `lastRequest`. */
  lastUsedAt: Date | null;
  /** Cloudgate's expiry (`apikey.agent_expires_at`), never the plugin's. */
  expiresAt: Date | null;
  /** Past `expiresAt`. An expired key stays listed until it is removed. */
  expired: boolean;
}

/**
 * An Agent, as the Agents section reads it.
 *
 * What is **not** here is as deliberate as what is. No address — an Agent's
 * `<id>@agents.cloudgate.invalid` exists because `user.email` is `NOT NULL`,
 * and showing it would make an Agent look like a person. No key
 * `permissions` or `metadata` — authority is the member row, and `metadata`
 * is writable by whoever holds the key.
 */
export interface AgentSummary extends Required<MemberEntitlements> {
  /** The Agent's user id, which is what `/agents/:id` addresses. */
  id: string;
  /** Its member row, which the role and entitlement routes address. */
  memberId: string;
  name: string;
  role: AgentRole;
  createdAt: Date;
  keys: AgentKeySummary[];
  /**
   * Whether a ban on the Agent's user is in force — the member-deactivation
   * ban Suspend writes and the endpoint refuses on, read with the same
   * predicate sign-in uses (`banInForce`), so a lapsed ban reads `false`.
   */
  suspended: boolean;
  /**
   * The person who created it, read from the Agent's own `create` audit row
   * (`metadata.type: 'createAgent'`) rather than from a column.
   *
   * The audit row is the one record that already holds this and keeps holding
   * it: it denormalizes the actor's name and email when it is written, so the
   * answer stays right after that person leaves the Organization or deletes
   * their account — which a join to `user` would not, and a new column would
   * duplicate. Only a person creates an Agent (`create` is owner or admin, and
   * an Agent is refused every REST route), so `email` is never an Agent's
   * synthetic address. `name` is null only on a row written before the change that added
   * the column, which no Agent's can be. `null` when no such row exists.
   */
  createdBy: AgentCreator | null;
  /**
   * What its MCP client last said about itself on `initialize`, across all
   * its keys — the latest one wins. **Self-reported**: the
   * endpoint records what the client claims and no decision reads it, so the
   * console labels it as such. `null` until a client has connected.
   */
  lastConnection: AgentConnection | null;
  /**
   * How many 429s it earned in the last hour, counted from its `refused`/
   * `rate-limit` audit rows — the row's loop signal, read with the
   * same query the Notification's restart check shares.
   */
  rateLimitedLastHour: number;
}

/** The self-reported "last connected" line, off the key that connected last. */
export interface AgentConnection {
  at: Date;
  clientName: string | null;
  clientVersion: string | null;
  /** The MCP protocol revision the endpoint served it at. */
  revision: string | null;
}

/** Who created an Agent, as its `create` audit row recorded them. */
export interface AgentCreator {
  name: string | null;
  email: string;
}

/**
 * Agents: Members that are not people, created and removed here
 * (ADR-0023).
 *
 * What this produces is an ordinary `member` row, so the existing role route
 * (`PATCH /organizations/members/:id`, which the one writer of `member.role`
 * keeps on the agent roles) and entitlement route
 * (`PATCH /organizations/members/:id/entitlements`) work on an Agent
 * unchanged. The Agents section is a new view onto members, not a new grant
 * model.
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly auditLogs: AuditLogService,
  ) {}

  /**
   * Creates an Agent in the caller's active Organization, and its first key,
   * and answers the key — **the only time it is ever shown**.
   *
   * Owner or admin only. `member: ['create']` is the authority, the one an
   * invitation takes, and the route declares it; this checks the static role
   * as `updateMemberEntitlements` does, because handing out a Member is
   * delegating authorization and a licensed custom role holding
   * `member: create` is refused it for the reason it cannot change a role.
   *
   * The user, the member row and the key are written in **one transaction**
   * there is no sign-up flow to hang an Agent on, and an Agent without
   * its membership, or a key without its Agent, is a state nothing should ever
   * have to read. The grant is checked against the Organization *before* the
   * transaction opens, with the same check Manage access makes, so an Agent is
   * never born holding another Organization's id.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateAgentDto,
    ip?: string,
  ): Promise<{ agent: AgentSummary; key: string }> {
    const organizationId = ctx.session.activeOrganizationId;
    await this.assertOwnerOrAdmin(ctx);
    const grant = fullEntitlements(data.grant);
    await this.permissions.assertEntitlementsResolve(organizationId, grant);

    const id = agentId();
    const email = normalizeEmail(agentEmail(id));
    const minted = await mintAgentKey(id, data.keyExpiresInDays);

    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.insert(user).values({
        id,
        firstName: data.name,
        lastName: '',
        email,
        emailVerified: false,
        kind: 'agent',
        createdAt: now,
        updatedAt: now,
      });
      await insertAgentMember(tx, {
        userId: id,
        organizationId,
        role: data.role,
        ...grant,
      });
      await tx.insert(apikey).values(minted.row);
    });

    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId, ip },
      {
        action: 'create',
        resourceType: 'user',
        resourceId: id,
        resourceName: data.name,
        metadata: {
          type: 'createAgent',
          role: data.role,
          keyExpiresInDays: data.keyExpiresInDays,
        },
      },
    );

    const [agent] = await this.summaries(organizationId, [id]);
    return { agent, key: minted.key };
  }

  /**
   * Every Agent of the caller's active Organization, oldest first, with its
   * keys. Any member of the Organization may read it, as any member may read
   * the Members list.
   */
  async list(ctx: PermissionCtx): Promise<AgentSummary[]> {
    await this.permissions.findMember(ctx);
    return this.summaries(ctx.session.activeOrganizationId);
  }

  /**
   * Deletes an Agent: its user row, which cascades to its member row, its keys
   * and any session. Owner or admin only, like {@link create}.
   *
   * Final, and the same operation that retires a person's account — there is
   * nothing to keep, because an Agent owns no Organization and no Service. The
   * audit trail survives it: `audit_log.user_id` is `set null`, and each row
   * keeps the actor's email and role, denormalized, so an Agent's own rows
   * still say an Agent acted.
   *
   * An id that is not an Agent of the caller's Organization — a person, an
   * Agent of another Organization, or nothing — is one and the same 404, so
   * the route cannot be used to learn which ids exist (§2.2).
   */
  async remove(
    ctx: PermissionCtx,
    id: string,
    ip?: string,
  ): Promise<{ success: true }> {
    const organizationId = ctx.session.activeOrganizationId;
    await this.assertOwnerOrAdmin(ctx);
    const target = await this.findAgent(organizationId, id);

    await this.db.delete(user).where(eq(user.id, target.id));

    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId, ip },
      {
        action: 'delete',
        resourceType: 'user',
        resourceId: target.id,
        resourceName: target.name,
        metadata: { type: 'deleteAgent', role: target.role },
      },
    );
    return { success: true };
  }

  /**
   * Suspends an Agent: its next `/mcp` call is refused `403 suspended`, and
   * nothing else changes — its keys, role and grant stay, so {@link resume}
   * puts it back exactly as it was.
   *
   * It is the member-deactivation ban — `user.banned`, read by `banInForce`
   * — which the endpoint already refuses on (`McpAuthenticator`). There was no
   * writer for it outside SCIM (the admin plugin's routes are unmounted), so
   * this writes the columns: banned, with {@link AGENT_SUSPENSION_REASON} and
   * no expiry, since a suspension lasts until somebody resumes it. Suspending
   * a suspended Agent writes the same ban again.
   *
   * Owner or admin, like every other Agent write; an id that is not an Agent
   * of this Organization is the one 404 {@link remove} answers.
   */
  async suspend(
    ctx: PermissionCtx,
    id: string,
    ip?: string,
  ): Promise<AgentSummary> {
    return this.writeBan(ctx, id, true, ip);
  }

  /**
   * Lifts a suspension: clears the whole ban, reason and expiry included, so
   * the next `/mcp` call is served with the same keys and grant it had.
   *
   * Any ban on an Agent is lifted, not only an operator's: an Agent has no
   * SCIM identity (`reviveScimTombstone` refuses one), so Suspend is the only
   * thing that bans it, and a ban nobody here can see the author of is not one
   * an operator should be unable to clear.
   */
  async resume(
    ctx: PermissionCtx,
    id: string,
    ip?: string,
  ): Promise<AgentSummary> {
    return this.writeBan(ctx, id, false, ip);
  }

  private async writeBan(
    ctx: PermissionCtx,
    id: string,
    banned: boolean,
    ip?: string,
  ): Promise<AgentSummary> {
    const organizationId = ctx.session.activeOrganizationId;
    await this.assertOwnerOrAdmin(ctx);
    const target = await this.findAgent(organizationId, id);

    await this.db
      .update(user)
      .set({
        banned,
        banReason: banned ? AGENT_SUSPENSION_REASON : null,
        banExpires: null,
        updatedAt: new Date(),
      })
      .where(eq(user.id, target.id));

    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId, ip },
      {
        action: 'update',
        resourceType: 'user',
        resourceId: target.id,
        resourceName: target.name,
        metadata: { type: banned ? 'suspendAgent' : 'resumeAgent' },
      },
    );

    const [agent] = await this.summaries(organizationId, [target.id]);
    return agent;
  }

  /**
   * Mints another key for an Agent and answers it — the only time it is shown.
   * Recovery (the key was lost) and rotation (the key
   * is old) are both this followed by {@link removeKey} on the old one, so
   * the client can be moved over before anything stops working.
   *
   * The key is `mintAgentKey`'s, as the first one is: hashed, its expiry in
   * `agent_expires_at`, and no `permissions` or `metadata`.
   */
  async addKey(
    ctx: PermissionCtx,
    id: string,
    expiresInDays: AgentKeyExpiryDays,
    ip?: string,
  ): Promise<{ agent: AgentSummary; key: string }> {
    const organizationId = ctx.session.activeOrganizationId;
    await this.assertOwnerOrAdmin(ctx);
    const target = await this.findAgent(organizationId, id);

    const minted = await mintAgentKey(target.id, expiresInDays);
    await this.db.insert(apikey).values(minted.row);

    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId, ip },
      {
        action: 'create',
        resourceType: 'user',
        resourceId: target.id,
        resourceName: target.name,
        metadata: {
          type: 'addAgentKey',
          keyId: minted.row.id,
          keyStart: minted.row.start,
          keyExpiresInDays: expiresInDays,
        },
      },
    );

    const [agent] = await this.summaries(organizationId, [target.id]);
    return { agent, key: minted.key };
  }

  /**
   * Deletes one of an Agent's keys: **Revoke** on a live key, which refuses
   * its next call as "This key is not valid.", and **Remove** on an expired
   * one, which only tidies the list. One operation — the row goes —
   * recorded as whichever it was, so the trail says whether a working key was
   * taken away.
   *
   * The key is looked up under the Agent, and the Agent under the caller's
   * Organization, so another Agent's key or a person's is the same 404 as a
   * key that does not exist. Revoking the last live key is allowed: the row
   * then reads "No valid key", which is what the operator asked for.
   */
  async removeKey(
    ctx: PermissionCtx,
    id: string,
    keyId: string,
    ip?: string,
  ): Promise<AgentSummary> {
    const organizationId = ctx.session.activeOrganizationId;
    await this.assertOwnerOrAdmin(ctx);
    const target = await this.findAgent(organizationId, id);

    const [key] = await this.db
      .select({
        id: apikey.id,
        start: apikey.start,
        expiresAt: apikey.agentExpiresAt,
      })
      .from(apikey)
      .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, target.id)))
      .limit(1);
    if (!key) throw new NotFoundException('Key not found');

    await this.db.delete(apikey).where(eq(apikey.id, key.id));

    const expired = agentKeyExpired(key.expiresAt);
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId, ip },
      {
        action: 'delete',
        resourceType: 'user',
        resourceId: target.id,
        resourceName: target.name,
        metadata: {
          type: expired ? 'removeExpiredAgentKey' : 'revokeAgentKey',
          keyId: key.id,
          keyStart: key.start,
        },
      },
    );

    const [agent] = await this.summaries(organizationId, [target.id]);
    return agent;
  }

  /**
   * An Agent of this Organization, or the one 404 for a person, another
   * Organization's Agent, or nothing — so no route learns which ids exist
   * (§2.2).
   */
  private async findAgent(
    organizationId: string,
    id: string,
  ): Promise<{ id: string; name: string; role: string }> {
    const [target] = await this.db
      .select({ id: user.id, name: user.firstName, role: member.role })
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .where(
        and(
          eq(user.id, id),
          eq(user.kind, 'agent'),
          eq(member.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!target) throw new NotFoundException('Agent not found');
    return target;
  }

  /**
   * Owner or admin of the caller's active Organization — the assertion the
   * member role and entitlement routes make (`OrganizationsService`).
   */
  private async assertOwnerOrAdmin(ctx: PermissionCtx): Promise<void> {
    const caller = await this.permissions.findMember(ctx);
    if (caller.role !== 'owner' && caller.role !== 'admin') {
      throw new ForbiddenException('Only owners and admins can manage Agents');
    }
  }

  /** The Agents of one Organization — or the named ones of it — with keys. */
  private async summaries(
    organizationId: string,
    ids?: string[],
  ): Promise<AgentSummary[]> {
    const agents = await this.db
      .select({
        id: user.id,
        memberId: member.id,
        name: user.firstName,
        role: member.role,
        createdAt: member.createdAt,
        accessedProjects: member.accessedProjects,
        accessedEnvironments: member.accessedEnvironments,
        accessedServices: member.accessedServices,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(user.kind, 'agent'),
          ...(ids ? [inArray(user.id, ids)] : []),
        ),
      )
      .orderBy(asc(member.createdAt), asc(member.id));
    if (agents.length === 0) return [];

    const keys = await this.db
      .select({
        id: apikey.id,
        referenceId: apikey.referenceId,
        start: apikey.start,
        createdAt: apikey.createdAt,
        lastUsedAt: apikey.lastRequest,
        expiresAt: apikey.agentExpiresAt,
        lastConnectedAt: apikey.lastConnectedAt,
        lastClientName: apikey.lastClientName,
        lastClientVersion: apikey.lastClientVersion,
        lastProtocolRevision: apikey.lastProtocolRevision,
      })
      .from(apikey)
      .where(
        inArray(
          apikey.referenceId,
          agents.map((agent) => agent.id),
        ),
      )
      .orderBy(asc(apikey.createdAt), asc(apikey.id));

    const creators = await this.creators(
      organizationId,
      agents.map((agent) => agent.id),
    );

    const now = Date.now();
    const rateLimited = await countRateLimited(
      this.db,
      agents.map((agent) => agent.id),
      new Date(now - RATE_LIMIT_WINDOW_MS),
    );
    return agents.map(({ banned, banExpires, ...agent }) => ({
      ...agent,
      // `member.role` is text; `member-role.ts`, its one writer, keeps every
      // Agent's on an agent role, and its census holds that.
      role: agent.role as AgentRole,
      suspended: banInForce({ banned, banExpires }),
      createdBy: creators.get(agent.id) ?? null,
      lastConnection: lastConnection(
        keys.filter((key) => key.referenceId === agent.id),
      ),
      rateLimitedLastHour: rateLimited.get(agent.id) ?? 0,
      keys: keys
        .filter((key) => key.referenceId === agent.id)
        .map((key) => ({
          id: key.id,
          start: key.start,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
          expired: agentKeyExpired(key.expiresAt, now),
        })),
    }));
  }

  /**
   * Each Agent's creator, from its `create` audit row — see
   * {@link AgentSummary.createdBy}. The earliest such row wins, though there is
   * only ever one: an Agent's id is minted by {@link create} and never reused.
   *
   * `metadata` is a JSON string in a `text` column, so the `createAgent` type
   * is read here rather than in SQL: a cast in the query would be evaluated
   * against whatever rows the planner reaches first, and one row of text that
   * is not JSON would fail the whole listing.
   */
  private async creators(
    organizationId: string,
    agentIds: string[],
  ): Promise<Map<string, AgentCreator>> {
    const rows = await this.db
      .select({
        agentId: auditLog.resourceId,
        name: auditLog.userName,
        email: auditLog.userEmail,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, organizationId),
          eq(auditLog.action, 'create'),
          eq(auditLog.resourceType, 'user'),
          inArray(auditLog.resourceId, agentIds),
        ),
      )
      .orderBy(asc(auditLog.createdAt));

    const creators = new Map<string, AgentCreator>();
    for (const row of rows) {
      if (row.agentId === null || creators.has(row.agentId)) continue;
      if (!isCreateAgentRow(row.metadata)) continue;
      // A person creates an Agent, so the row always has an address; only a
      // platform-written row has none, and the platform creates none.
      if (row.email === null) continue;
      creators.set(row.agentId, { name: row.name, email: row.email });
    }
    return creators;
  }
}

/** The connection of whichever key connected last, or `null` if none has. */
function lastConnection(
  keys: Array<{
    lastConnectedAt: Date | null;
    lastClientName: string | null;
    lastClientVersion: string | null;
    lastProtocolRevision: string | null;
  }>,
): AgentConnection | null {
  let latest: AgentConnection | null = null;
  for (const key of keys) {
    if (key.lastConnectedAt === null) continue;
    if (latest !== null && key.lastConnectedAt <= latest.at) continue;
    latest = {
      at: key.lastConnectedAt,
      clientName: key.lastClientName,
      clientVersion: key.lastClientVersion,
      revision: key.lastProtocolRevision,
    };
  }
  return latest;
}

function isCreateAgentRow(metadata: string | null): boolean {
  if (metadata === null) return false;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === 'createAgent'
    );
  } catch {
    return false;
  }
}
