/**
 * The project-config module's **wired variables** entry point (ADR-0031): the
 * Outputs table and values, a deploy's fill-in, and the refusal
 * of a typed value for a linked name. Apart from `../index.ts` for the same
 * reason as `../console-saves`: the Service modules and the deployment
 * engine call it, and `ProjectConfigModule` imports them.
 */
export {
  OUTPUTS,
  outputsChangedBy,
  outputsMovedBy,
  outputsOf,
  outputsWithoutValue,
  outputValues,
} from './outputs';
export type { OutputKind, OutputSource, SourceAddress } from './outputs';
export {
  clearWiredChanged,
  isLinkingType,
  linkSourceStates,
  markServicesWiredChanged,
  markWiredChanged,
  refuseWhileLinked,
  SERVICE_IS_LINKED_CODE,
  servicesLinking,
  servicesStillWiredChanged,
} from './linked-services';
export type { LinkingType } from './linked-services';
export {
  linkedS3Buckets,
  previewLinks,
  refuseTypedLinkedNames,
  VARIABLE_IS_LINKED_CODE,
  wiredEnv,
} from './wired-env';
