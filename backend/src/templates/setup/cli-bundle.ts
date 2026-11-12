/**
 * What an Instance does to a Template's compose part at setup, as
 * `cloudgate template try` bundles it from source (`cli/build.mjs`, spec #5):
 * the values made once at setup, the config files filled in with them, the
 * Domains' setup names, and the compose file preparation. One code path, so
 * `try` cannot drift from an Instance. Nothing reachable from here may need
 * Nest's container, a database, Traefik, the volume lock or a Docker client
 * at runtime.
 */
export { makeValues, fillFileText } from './setup-values';
export type {
  MadeValues,
  RandomSource,
  SetupAnswers,
  ValueProblem,
} from './setup-values';
export { setupDomains } from './setup-domains';
export type { SetupDomain } from './setup-domains';
export {
  applyComposeDefaults,
  composeDotenvLine,
} from '../../compose/compose-file';
export { publishStackVmPorts } from '../../compose/stack-vm-ports';
export type { StackVmRoute } from '../../compose/stack-vm-ports';
