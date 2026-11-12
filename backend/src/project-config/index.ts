/**
 * The `project-config` module's public interface. Other modules import
 * from here and never from inside it: the format, and later the planner,
 * generator, applier and config reader port (`reader/`), are its
 * internal parts.
 *
 * {@link ProjectConfigService} is what other modules inject: a new
 * Project's empty config, reading a Project's config, saving a whole YAML
 * text as a plan per Environment, and asking for, reading, applying
 * and dismissing an Environment's Plan. {@link planEnvironment} is the pure
 * planner behind it; the Applier (`applier/`) runs a plan through each
 * kind's own create and update paths and is reached only through the
 * service.
 *
 * The Format: {@link parseProjectConfig} reads a `version: 1`
 * text into a {@link ProjectConfig} in backend field names, or refuses it with a
 * {@link ConfigRefusal} naming `<service>.<field>`, and
 * {@link projectConfigJsonSchema} is the JSON Schema generated from the same
 * Zod schema, served at `/schema/project-config/v1.json`.
 */
export { ProjectConfigModule } from './project-config.module';
// The HTTP twins the MCP Project config tools mirror.
export {
  PlansController,
  ProjectConfigsController,
} from './project-config.controller';
export {
  CONFIG_PATH_AMBIGUOUS_CODE,
  CONFIG_UNREADABLE_CODE,
  EMPTY_CONFIG_TEXT,
  MOVE_STALE_CODE,
  PLAN_DESTROY_NOT_CONFIRMED_CODE,
  PLAN_NOT_OPEN_CODE,
  PLAN_REFUSED_CODE,
  PLAN_UPGRADE_NOT_CONFIRMED_CODE,
  PLAN_STALE_CODE,
  PROJECT_CONFIG_MISSING_CODE,
  PROJECT_CONFIG_NOT_REPOSITORY_KEPT_CODE,
  PROJECT_CONFIG_REPOSITORY_KEPT_CODE,
  ProjectConfigService,
} from './project-config.service';
export type {
  ConfigLocationView,
  ConfirmedMove,
  EnvironmentConfigCopy,
  HeldBuild,
  StoppedDeployment,
  MovePreview,
  PlanView,
  ProjectConfigView,
  RepositoryLocationView,
  SavedConfigPlans,
} from './project-config.views';
export { parseProjectConfig } from './format/parse-config';
export { serviceEntries, withServiceEntries } from './format/config-entries';
export { kindsOn, planEnvironment } from './planner/plan-environment';
export { generateProjectConfig } from './generator/generate-config';
export { ConfigGenerationService } from './generator/config-generation.service';
export type {
  GeneratorEnvironment,
  GeneratorInput,
} from './generator/generate-config';
export type { PlanStepDeploy, PlanStepResult } from './applier/apply.types';
export { isNetworkStep } from './planner/cloud-steps';
export type {
  CloudRead,
  CloudPostgresChange,
  CloudRedisChange,
  CloudWebCreate,
  StackVmCreate,
  ConfigKind,
  ConfigOutline,
  DeployTarget,
  ElastiCacheConsoleSettings,
  FieldDiff,
  MajorUpgrade,
  PendingSetupInput,
  PendingSetupPart,
  PlanContext,
  PlanInput,
  PlanNote,
  PlanOutcome,
  PlanRefusal,
  PlanStep,
  RdsConsoleSettings,
  SavedApplicationSettings,
  SavedComposeSettings,
  SavedPostgresSettings,
  SavedRedisSettings,
  SavedService,
  SavedStackVm,
  SavedVariableKeys,
  SetupRecordInput,
  StackVmChange,
  SizePair,
  TemplateCreate,
  TemplateDomain,
  TemplateFile,
  VariableList,
} from './planner/plan.types';
export {
  CONFIG_NAME_REGEX,
  EXPRESSIBLE_KINDS,
  projectConfigJsonSchema,
} from './format/config-schema';
export { SIZES, SIZE_NAMES, sizeLimits } from './format/config-size';
export type { Size, SizeName } from './format/config-size';
export type {
  ComposeEntry,
  ConfigRefusal,
  ConsoleManagedEntry,
  ParseResult,
  PostgresEntry,
  MysqlEntry,
  ProjectConfig,
  RedisEntry,
  ServiceEntry,
  Source,
  StaticBuild,
  StaticEntry,
  WebBuild,
  WebEntry,
} from './project-config.types';
