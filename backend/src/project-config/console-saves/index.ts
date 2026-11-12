/**
 * The project-config module's second entry point: the console Saves
 * seam that each Service kind's own create, update and Delete paths call. It
 * is apart from `../index.ts` because that one carries `ProjectConfigModule`,
 * which imports those Service modules — importing it from them would be a
 * cycle.
 */
export { ConsoleSavesModule } from './console-saves.module';
export {
  ConsoleSaves,
  whilePlanApplies,
  writeKept,
} from './console-saves.service';
export {
  KEEP_NOTHING,
  LINK_NEEDS_CONFIG_CODE,
  LINK_REFUSED_CODE,
  PROJECT_CONFIG_NOT_KEPT_CODE,
} from './console-saves.service';
export type {
  ConsoleEdit,
  KeepConfig,
  SaveOptions,
  Written,
} from './console-saves.service';
