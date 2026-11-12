import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { checkServerAccess } from '../common/owned-server';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { registry } from '../db/schema';
import type { Registry } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import type {
  CreateRegistryDto,
  TestRegistryConnectionDto,
  TestSavedRegistryConnectionDto,
  UpdateRegistryDto,
} from './dto/registry.dto';
import {
  REGISTRY_LOGIN_PASSWORD_HOLDER,
  registryLoginFailure,
  registryLoginProbeCommand,
} from './registry-login';

/** What a `docker login` needs, whichever table it came out of. */
export interface RegistryLoginCredentials {
  /** Hostname[:port]; empty or null is Docker Hub. */
  url: string | null | undefined;
  username: string;
  password: string;
}

/** A registry as exposed over the API — the password never leaves the server. */
export type SanitizedRegistry = Omit<Registry, 'password'>;

function stripPassword(row: Registry): SanitizedRegistry {
  const { password, ...rest } = row;
  void password;
  return rest;
}

@Injectable()
export class RegistriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
    // With no Server named, `docker login` runs on the platform host
    // with the caller's password — refused in hosted mode.
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Create a registry, scoped to the session's active organization. */
  async create(
    ctx: PermissionCtx,
    data: CreateRegistryDto,
  ): Promise<SanitizedRegistry> {
    const [created] = await this.db
      .insert(registry)
      .values({ ...data, organizationId: ctx.session.activeOrganizationId })
      .returning();
    return stripPassword(created);
  }

  /** The organization's registries, passwords stripped. */
  async list(ctx: PermissionCtx): Promise<SanitizedRegistry[]> {
    const rows = await this.db
      .select()
      .from(registry)
      .where(eq(registry.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(registry.createdAt));
    return rows.map(stripPassword);
  }

  /** One registry, org-scoped, password stripped. */
  async findOne(
    ctx: PermissionCtx,
    registryId: string,
  ): Promise<SanitizedRegistry> {
    return stripPassword(await this.findOneWithCredentials(ctx, registryId));
  }

  /** Update a registry, org-scoped through findOneWithCredentials. */
  async update(
    ctx: PermissionCtx,
    registryId: string,
    data: UpdateRegistryDto,
  ): Promise<SanitizedRegistry> {
    const current = await this.findOneWithCredentials(ctx, registryId);
    const [updated] = await this.db
      .update(registry)
      .set(data)
      .where(eq(registry.registryId, current.registryId))
      .returning();
    return stripPassword(updated);
  }

  /** Delete a registry, org-scoped through findOneWithCredentials. */
  async remove(
    ctx: PermissionCtx,
    registryId: string,
  ): Promise<SanitizedRegistry> {
    const current = await this.findOneWithCredentials(ctx, registryId);
    const [removed] = await this.db
      .delete(registry)
      .where(eq(registry.registryId, current.registryId))
      .returning();
    return stripPassword(removed);
  }

  /**
   * Whether the registry accepts the credential on screen, before it is
   * saved. Resolves when it does; a refusal is a 400 carrying the registry's own
   * answer.
   *
   * `serverId` names the machine that logs in — the platform host when omitted
   * — and is scoped to the caller's organization: unscoped, a test route
   * is the cheapest way to run a command on another organization's Server.
   */
  async testConnection(
    ctx: PermissionCtx,
    data: TestRegistryConnectionDto,
  ): Promise<void> {
    const { serverId, ...credentials } = data;
    if (!serverId) this.instanceMode.refusePlatformHost('checks');
    await checkServerAccess(this.db, ctx, serverId);
    return this.probeLogin(credentials, serverId ?? null);
  }

  /**
   * The same probe against a registry that is already saved, with the
   * row's decrypted password — the credential the next push will log in with.
   * The registry is org-scoped by the lookup and the Server by its own check:
   * two ids, two lookups (`destinations.service.ts`' `testSavedConnection`).
   */
  async testSavedConnection(
    ctx: PermissionCtx,
    registryId: string,
    data: TestSavedRegistryConnectionDto,
  ): Promise<void> {
    if (!data.serverId) this.instanceMode.refusePlatformHost('checks');
    const found = await this.findOneWithCredentials(ctx, registryId);
    await checkServerAccess(this.db, ctx, data.serverId);
    return this.probeLogin(found, data.serverId ?? null);
  }

  /**
   * The one registry-login probe, for this module's two routes and for
   * an Application's Docker-image source, which holds the same three values in
   * its own columns. Unscoped by design: every caller has already resolved the
   * credential and the Server inside the caller's organization, and this only
   * runs {@link registryLoginProbeCommand} where it was told to.
   *
   * The password travels in the program's **environment** under
   * {@link REGISTRY_LOGIN_PASSWORD_HOLDER}, and the command holds only a
   * reference to it — so `ExecError.command`, which pino writes several
   * times over, has nothing in it to leak. Locally the environment is spread
   * over `process.env` because `ExecOptions.env` replaces rather than extends,
   * which is `DeploymentEngineService.exec`'s fork for the same reason; the
   * dispatch is written out rather than taken from `execOnServer`, which has no
   * environment to carry.
   */
  async probeLogin(
    credentials: RegistryLoginCredentials,
    serverId: string | null,
  ): Promise<void> {
    const command = registryLoginProbeCommand(
      credentials.url,
      credentials.username,
    );
    const env = { [REGISTRY_LOGIN_PASSWORD_HOLDER]: credentials.password };
    try {
      if (serverId) {
        await this.remoteExec.execAsyncRemote(serverId, command, undefined, {
          env,
        });
      } else {
        await this.remoteExec.execAsync(command, {
          env: { ...process.env, ...env },
        });
      }
    } catch (error) {
      // The object form carries `output` through `AllExceptionsFilter` beside
      // the sentence, for the console's Details disclosure.
      throw new BadRequestException(
        registryLoginFailure(error, credentials.password, credentials.url),
      );
    }
  }

  /**
   * The full row including the decrypted password, for internal use (auth
   * config, docker login). Never returned from a controller.
   */
  async findOneWithCredentials(
    ctx: PermissionCtx,
    registryId: string,
  ): Promise<Registry> {
    const [found] = await this.db
      .select()
      .from(registry)
      .where(
        and(
          eq(registry.registryId, registryId),
          eq(registry.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Registry not found');
    return found;
  }
}
