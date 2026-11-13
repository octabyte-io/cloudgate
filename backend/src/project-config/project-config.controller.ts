import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  ApplyPlanDto,
  ConfirmMoveDto,
  DismissPlanDto,
  PreviewMoveDto,
  SaveConfigTextDto,
} from './dto/plan.dto';
import { ConfigSourcesDto } from './dto/config-sources.dto';
import { ConfigRepositorySourcesDto } from './dto/repository-sources.dto';
import { projectConfigJsonSchema } from './format/config-schema';
import { ProjectConfigService } from './project-config.service';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

/**
 * The Project config's JSON Schema, for an editor (US5).
 *
 * `@Public()` because the reader is a YAML language server fetching the URL a
 * `cloudgate.yaml`'s `$schema` comment names, and it carries no session. The
 * document is the format's grammar and nothing else: no Organization, Project
 * or Service is in it, so serving it to anyone discloses only what a reader of
 * the open-source tree already has.
 */
@Controller('schema')
export class ProjectConfigSchemaController {
  /** The `version: 1` schema; anyone may read it. */
  @Public()
  @Get('project-config/v1.json')
  @Header('Cache-Control', 'public, max-age=300')
  // A JSON Schema document, whose own shape no zod DTO describes (§2.2).
  @ApiOkResponse({
    description: 'The draft-07 JSON Schema of a version 1 Project config',
  })
  findV1() {
    return projectConfigJsonSchema();
  }
}

/** A Project's config, on the Project's read entitlement. */
@Controller('projects')
export class ProjectConfigsController {
  constructor(private readonly projectConfig: ProjectConfigService) {}

  /**
   * The config's location, its version and, kept in Cloudgate, its text: what
   * a working copy is downloaded from (ADR-0080).
   */
  @Get(':projectId/config')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('projectId') projectId: string,
  ) {
    return this.projectConfig.findConfig(toCtx(user, session), projectId);
  }

  /**
   * The whole-YAML edit (US16): stores a plan per Environment and
   * applies nothing; the text is stored when one of them is applied. A read
   * of each Environment, as asking for each plan is. A `version` names the
   * config version the edit started from, and is refused with
   * `CONFIG_VERSION_STALE` once the config has moved on (ADR-0080).
   */
  @Post(':projectId/config/plans')
  @RequirePermission('environment', 'read')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('projectId') projectId: string,
    @Body() body: SaveConfigTextDto,
  ) {
    return this.projectConfig.savePlans(
      toCtx(user, session),
      projectId,
      body.text,
      body.version,
    );
  }

  /**
   * A move's preview (US69): reads every Environment's copy at the
   * new place — or, moving out of a repository, the one copy kept —
   * and answers its plan, storing nothing. Changing where the
   * config is kept is `project: update`, and so is looking at what it would
   * do, since the preview reads through the organization's connection.
   */
  @Post(':projectId/config/move/preview')
  @HttpCode(200)
  @RequirePermission('project', 'update')
  preview(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('projectId') projectId: string,
    @Body() body: PreviewMoveDto,
  ) {
    return this.projectConfig.previewMove(
      toCtx(user, session),
      projectId,
      body.to,
    );
  }

  /**
   * A move's confirm: refused if the preview's reads changed; switches the
   * location, dismisses the open plans and stores the previewed ones open;
   * a move out also stores the kept copy and clears every Config branch.
   * Applies nothing.
   */
  @Post(':projectId/config/move')
  @HttpCode(200)
  @RequirePermission('project', 'update')
  move(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('projectId') projectId: string,
    @Body() body: ConfirmMoveDto,
  ) {
    return this.projectConfig.confirmMove(
      toCtx(user, session),
      projectId,
      body.to,
      body.reads,
    );
  }
}

/**
 * An Environment's Plan (US68): seeing one or asking for one needs
 * `environment: read`, dismissing one `environment: update`. Applying one
 * is checked against the statements each step's Service uses
 * (`service: create/update/delete`, `deployment: create`), all before any
 * step runs (US67), in the service: the route asks only that the caller can see
 * the Environment.
 */
@Controller('environments')
export class PlansController {
  constructor(private readonly projectConfig: ProjectConfigService) {}

  /**
   * The Environment's copy of the config (US55): a repository-kept
   * config's read now from its Config branch, with its commit and a link to
   * the file, or why it cannot be read.
   */
  @Get(':environmentId/config')
  @RequirePermission('environment', 'read')
  findCopy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.projectConfig.findCopy(toCtx(user, session), environmentId);
  }

  /**
   * The Services whose source the config, as this Environment reads it,
   * names as a repository: `cloudgate deploy` refuses to upload to
   * one. Only Config names, providers and repositories; never the text.
   */
  @Get(':environmentId/config/repository-sources')
  @RequirePermission('environment', 'read')
  @ApiOkResponse({ type: ConfigRepositorySourcesDto })
  repositorySources(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.projectConfig.repositorySources(
      toCtx(user, session),
      environmentId,
    );
  }

  /**
   * Every entry of the config, as this Environment reads it, and where its
   * code comes from: a root `cloudgate deploy` in a Project folder builds
   * the ones from a subfolder of it (ADR-0080). Never the text.
   */
  @Get(':environmentId/config/sources')
  @RequirePermission('environment', 'read')
  @ApiOkResponse({ type: ConfigSourcesDto })
  configSources(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.projectConfig.configSources(
      toCtx(user, session),
      environmentId,
    );
  }

  /** The open plan, else the latest, else `{ plan: null }`. */
  @Get(':environmentId/plan')
  @RequirePermission('environment', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.projectConfig.findPlan(toCtx(user, session), environmentId);
  }

  /** "Check for changes": makes a plan, which replaces the open one. */
  @Post(':environmentId/plan')
  @RequirePermission('environment', 'read')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
  ) {
    return this.projectConfig.requestPlan(toCtx(user, session), environmentId);
  }

  @Post(':environmentId/plan/dismiss')
  @HttpCode(200)
  @RequirePermission('environment', 'update')
  dismiss(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
    @Body() body: DismissPlanDto,
  ) {
    return this.projectConfig.dismissPlan(
      toCtx(user, session),
      environmentId,
      body.planId,
    );
  }

  /** Applies the open plan: creates, changes, then confirmed destroys, each on its own. */
  @Post(':environmentId/plan/apply')
  @HttpCode(200)
  @RequirePermission('environment', 'read')
  apply(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('environmentId') environmentId: string,
    @Body() body: ApplyPlanDto,
  ) {
    return this.projectConfig.applyPlan(
      toCtx(user, session),
      environmentId,
      body.planId,
      { destroy: body.confirmDestroy, upgrade: body.confirmUpgrade },
      body.deleteFilesOf,
      body.deleteDataOf,
    );
  }
}
