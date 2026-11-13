import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns } from 'drizzle-orm';

import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  environment,
  gitProvider,
  project,
  projectConfigLocation,
  user,
} from '../db/schema';
import type { Environment, ProjectConfigLocation } from '../db/schema';
import type { DrizzleTx } from '../environments/config-name';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { pointedAt, repositoryKept } from './console-saves/repository-kept';
import { moveVersion } from './config-version';
import { configMissing, staleVersion } from './plan-errors';
import type { ConfigLocationView } from './project-config.views';
import { CONFIG_READER } from './reader/config-reader.port';
import type {
  ConfigReader,
  ConfigReadResult,
} from './reader/config-reader.port';
import { readPlace } from './reader/repository-place';
import type { RepositoryPlace } from './reader/repository-place';
import { textHash } from './saved-settings';

/**
 * Where a Project's config is kept, and the reads every part of the module
 * shares: the location row and its view, a repository copy through
 * the config reader port, the Cloudgate-kept text, and the Project and
 * Environment a call names, inside the caller's organization.
 */
@Injectable()
export class ConfigLocations {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    @Inject(CONFIG_READER) private readonly reader: ConfigReader,
  ) {}

  /** Reads one copy through the config reader port. */
  readCopy(
    place: RepositoryPlace,
    ref: string | null,
  ): Promise<ConfigReadResult> {
    return readPlace(this.reader, place, ref);
  }

  /** The location as the API answers it, with its connection's name and type. */
  async locationView(projectId: string): Promise<ConfigLocationView | null> {
    const [found] = await this.db
      .select({
        location: projectConfigLocation,
        providerType: gitProvider.providerType,
        connectionName: gitProvider.name,
      })
      .from(projectConfigLocation)
      .leftJoin(
        gitProvider,
        eq(projectConfigLocation.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(projectConfigLocation.projectId, projectId))
      .limit(1);
    if (!found) return null;
    const { location } = found;
    if (location.kind === 'cloudgate') {
      return location.text === null
        ? null
        : {
            kind: 'cloudgate',
            text: location.text,
            textHash: textHash(location.text),
            version: location.version,
            updatedAt: location.updatedAt,
            movedOutOf: location.movedOutOf,
          };
    }
    return {
      kind: 'repository',
      gitProviderId: location.gitProviderId,
      providerType: found.providerType,
      connectionName: found.connectionName,
      repository: location.repository ?? '',
      path: location.path ?? '',
      version: location.version,
      updatedAt: location.updatedAt,
    };
  }

  /** Where a repository-kept config is read; `null` when it is not one. */
  async repositoryPlace(projectId: string): Promise<RepositoryPlace | null> {
    const view = await this.locationView(projectId);
    return view?.kind === 'repository' ? view : null;
  }

  async findLocation(
    projectId: string,
  ): Promise<ProjectConfigLocation | undefined> {
    const [location] = await this.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId))
      .limit(1);
    return location;
  }

  /**
   * The Cloudgate-kept text, or a 409 for a Project with no config yet or
   * one kept in a repository, which Cloudgate holds no text of. That one
   * carries the same pointer a console write's refusal does, at the
   * repository's default branch: the edit named no Environment.
   */
  async storedText(projectId: string): Promise<string> {
    const location = await this.findLocation(projectId);
    if (location?.kind === 'repository') {
      const place = await this.repositoryPlace(projectId);
      const read = place ? await this.readCopy(place, null) : null;
      const pointer = {
        repository: location.repository ?? '',
        path: location.path ?? '',
        branch: read?.branch ?? null,
        fileUrl: read?.ok ? read.fileUrl : null,
      };
      throw repositoryKept(
        `This Project's config is kept in ${pointedAt(pointer)}; change it there, then check for changes`,
        pointer,
      );
    }
    if (location?.kind !== 'cloudgate' || location.text === null) {
      throw configMissing();
    }
    return location.text;
  }

  /**
   * Refuses an edit that started from `version` once the config has moved
   * on (ADR-0080); `undefined` refuses nothing. The row is locked either
   * way, so inside a transaction no write lands between the check and the
   * edit's own.
   */
  async refuseStaleVersion(
    db: DrizzleDB | DrizzleTx,
    projectId: string,
    version: number | undefined,
  ): Promise<void> {
    const [found] = await db
      .select({
        version: projectConfigLocation.version,
        changedAt: projectConfigLocation.updatedAt,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      })
      .from(projectConfigLocation)
      .leftJoin(user, eq(projectConfigLocation.changedBy, user.id))
      .where(eq(projectConfigLocation.projectId, projectId))
      .limit(1)
      .for('update', { of: projectConfigLocation });
    if (!found || version === undefined || found.version === version) return;
    throw staleVersion(version, {
      changedAt: found.changedAt,
      // A person is named as the console names them; Cloudgate itself, or
      // a write from before versions were recorded, by no one.
      changedBy:
        found.email === null
          ? null
          : `${found.firstName ?? ''} ${found.lastName ?? ''}`.trim() ||
            found.email,
    });
  }

  /**
   * Stores the Cloudgate-kept text, which moves the version. A text identical
   * to the stored one writes nothing and keeps the version, so a run that
   * changes nothing never stales anyone's working copy (ADR-0080). Not
   * scoped here: the caller has already found the Project inside its
   * organization and asked the statement the write needs.
   */
  async writeText(
    tx: DrizzleTx,
    projectId: string,
    text: string,
    changedBy: string | null,
  ) {
    const [found] = await tx
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId))
      .limit(1)
      .for('update');
    if (found?.text === text) return;
    await moveVersion(tx, projectId, changedBy, { text });
  }

  /** The Project's Environments, oldest first. */
  environmentsOf(projectId: string): Promise<Environment[]> {
    return this.db
      .select()
      .from(environment)
      .where(eq(environment.projectId, projectId))
      .orderBy(environment.createdAt, environment.environmentId);
  }

  /**
   * The Project, inside the caller's organization (404 otherwise). The
   * caller has asked the entitlement it needs first.
   */
  async projectInOrganization(ctx: PermissionCtx, projectId: string) {
    const [found] = await this.db
      .select({ projectId: project.projectId })
      .from(project)
      .where(
        and(
          eq(project.projectId, projectId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Project not found');
    return found;
  }

  /**
   * The Environment, inside the caller's organization and past its
   * row-level check at `action`. The check comes first, so a caller without
   * the action learns nothing about whether the id resolves (§2.2).
   */
  async findEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
    action: 'read' | 'update',
  ): Promise<Environment> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, action);
    const [found] = await this.db
      .select(getTableColumns(environment))
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }
}
