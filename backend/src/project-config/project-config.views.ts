import type { DeploymentStatus, MovedOutOf, Plan } from '../db/schema';
import type { GitProviderType } from '../git-providers/git-provider.schema';
import type { ConfigLocationTarget, ConfigRead } from './dto/plan.dto';
import type { ExpressibleServiceType } from './format/config-schema';
import type { VariableList } from './planner/fields';
import type { PlanNote, PlanStep } from './planner/plan.types';
import type { ConfigReadRefusalReason } from './reader/config-reader.port';

/*
 * What the project-config module answers: the views its HTTP API and
 * the MCP tools return, shared by the services that build them.
 */

/** A Cloudgate-kept config, with its text. */
export interface CloudgateLocationView {
  readonly kind: 'cloudgate';
  readonly text: string;
  readonly textHash: string;
  /**
   * The config's version (ADR-0080): a whole-YAML edit naming an older one
   * is refused. Compared only for equality.
   */
  readonly version: number;
  /** When the version last moved. */
  readonly updatedAt: string;
  /**
   * The repository file it was moved out of (US65), which Cloudgate no
   * longer reads; `null` for a config never moved out.
   */
  readonly movedOutOf: MovedOutOf | null;
}

/**
 * A repository-kept config: where it is read, never its text, which each
 * Environment reads from its own Config branch (`GET
 * /environments/:environmentId/config`). The connection fields are `null`
 * once the connection is deleted.
 */
export interface RepositoryLocationView {
  readonly kind: 'repository';
  readonly gitProviderId: string | null;
  readonly providerType: GitProviderType | null;
  readonly connectionName: string | null;
  readonly repository: string;
  readonly path: string;
  /** The config's version, moved by every Apply (ADR-0080). */
  readonly version: number;
  readonly updatedAt: string;
}

export type ConfigLocationView = CloudgateLocationView | RepositoryLocationView;

/** A Project's config as `GET /projects/:projectId/config` answers it. */
export interface ProjectConfigView {
  readonly projectId: string;
  /**
   * `null` for a Project made before configs existed, until the boot step
   * that generates one (`ConfigGenerationService`) has run.
   */
  readonly location: ConfigLocationView | null;
}

/**
 * One Environment's copy of the config, as `GET
 * /environments/:environmentId/config` answers it (US55): read live
 * from its Config branch for a repository-kept config, never stored. A
 * Cloudgate-kept config has one copy, the Project's text.
 */
export type EnvironmentConfigCopy =
  | { readonly kind: 'cloudgate'; readonly environmentId: string }
  | {
      readonly kind: 'repository';
      readonly environmentId: string;
      readonly repository: string;
      readonly path: string;
      /** The Environment's Config branch; `null` is the default branch. */
      readonly configBranch: string | null;
      readonly copy: {
        readonly text: string;
        readonly commitSha: string;
        readonly branch: string;
        readonly fileUrl: string;
      } | null;
      readonly refusal: {
        readonly reason: ConfigReadRefusalReason;
        readonly branch: string | null;
        readonly message: string;
      } | null;
      /**
       * The Environment's Services of a kind the config describes, and
       * whether the file owns their config-owned fields (US56): it
       * describes them, or the copy cannot be read or parsed, so a console
       * write of one would be refused. The console locks those fields.
       */
      readonly services: readonly LockedService[];
    };

/** One Service as a repository-kept config's copy locks it. */
export interface LockedService {
  readonly serviceType: ExpressibleServiceType;
  readonly serviceId: string;
  readonly configName: string;
  readonly owned: boolean;
  /**
   * Of the fields the config sets only when it states them (`size`, a
   * postgres's `database` and `user`), those the file states — every one
   * when the file cannot be read. One it does not state stays the console's,
   * so only these are locked.
   */
  readonly stated: readonly string[];
  /**
   * The variable names the file lists, per list. A listed name may be given
   * a value in the console; any other new name is the file's to add. Empty
   * when the file cannot be read.
   */
  readonly listed: Readonly<Record<VariableList, readonly string[]>>;
  /**
   * The plan its config-owned fields were last written from
   * (`config_plan_id`), with the commit that plan read; `null` when no plan
   * has written them (made in the console before the move, say).
   */
  readonly appliedFrom: {
    readonly planId: string;
    readonly commitSha: string | null;
    readonly branch: string | null;
    readonly appliedAt: string | null;
  } | null;
}

/** A move's target as resolved inside the caller's organization. */
export type ResolvedTarget =
  | (Omit<Extract<ConfigLocationTarget, { kind: 'repository' }>, 'path'> & {
      /** The path asked for, or the one a move with none found (#1344). */
      readonly path: string;
      readonly providerType: GitProviderType;
      readonly connectionName: string;
    })
  | {
      readonly kind: 'cloudgate';
      /** The Environment whose copy is kept; `null` is the default branch's. */
      readonly fromEnvironmentId: string | null;
      /** The copy that becomes the Cloudgate-kept text, and where it was read. */
      readonly copy: {
        readonly repository: string;
        readonly path: string;
        readonly branch: string;
        readonly commitSha: string;
        readonly fileUrl: string;
        readonly text: string;
      };
    };

/**
 * What a move's preview answers (US62): each Environment's plan
 * against its copy at the new place, and the reads a confirm carries back.
 */
export interface MovePreview {
  readonly to: ResolvedTarget;
  readonly reads: ConfigRead[];
  readonly environments: Array<{
    readonly environmentId: string;
    readonly name: string;
    /** The branch read; `null` for a target with no branches. */
    readonly branch: string | null;
    readonly commitSha: string | null;
    readonly fileUrl: string | null;
    readonly steps: PlanStep[];
    readonly notes: PlanNote[];
  }>;
}

/** What a confirmed move answers: the new location and the plans it left open. */
export interface ConfirmedMove {
  readonly location: ConfigLocationView;
  readonly plans: PlanView[];
}

/**
 * A plan as the API answers it: the row without the config text it was made
 * from, which is the Project's config and is read through the Project
 * (`GET /projects/:projectId/config`), not through an Environment, and
 * without its outline, which only the next plan reads.
 */
export type PlanView = Omit<Plan, 'text' | 'outline'> & {
  /**
   * The builds this plan holds or held (US51): each Application build
   * a push recorded `held` for it, with its status now — `held` until the
   * plan's Apply, dismiss, a newer plan or "build now" releases it.
   */
  readonly heldBuilds: HeldBuild[];
  /**
   * The deploy that stopped on this plan: a cloud Service's deploy
   * no Apply queued that met more than its new image, whose whole plan this
   * is. Its step is the change of `configName`. `null` on any other plan.
   */
  readonly stoppedDeployment: StoppedDeployment | null;
};

/** A deploy a plan was opened for, as the plan view names it. */
export interface StoppedDeployment {
  readonly deploymentId: string;
  readonly applicationId: string;
  readonly configName: string;
  readonly title: string;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
}

/** A build a plan holds or held, as the plan view lists it. */
export interface HeldBuild {
  readonly deploymentId: string;
  readonly applicationId: string;
  readonly configName: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
}

/** A plan row as the API answers it, with the builds it holds or held and the deploy it stopped. */
export function toView(
  row: Plan,
  heldBuilds: HeldBuild[],
  stoppedDeployment: StoppedDeployment | null = null,
): PlanView {
  const { text, outline, ...view } = row;
  void text;
  void outline;
  return { ...view, heldBuilds, stoppedDeployment };
}

/** What saving a whole YAML text answers: a plan per Environment. */
export interface SavedConfigPlans {
  /**
   * Whether the text was stored at once, which it is only when no
   * Environment has anything to change; otherwise it is stored when a plan
   * of it is applied.
   */
  readonly stored: boolean;
  readonly plans: PlanView[];
}
