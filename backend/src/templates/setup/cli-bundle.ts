/**
 * What an Instance does to a Template's compose part at setup, as
 * `cloudgate template try` bundles it from source (`cli/build.mjs`, spec #5):
 * the values made once at setup, the config files filled in with them, the
 * Domains' setup names, which inputs the compose part's `.env` carries, and
 * the compose file preparation. One code path, so `try` cannot drift from an
 * Instance.
 *
 * Nothing reachable from here may load Traefik, the volume lock or a Docker
 * client (`test/compose/compose-file.spec.ts` walks it), and nothing may need
 * Nest's container or a database to run. It does load Nest and `nestjs-zod`
 * code: the Template check it shares reaches them through the config parser
 * (ADR-0046), and `setupDomains` reads `hostSchema` from
 * `domains/dto/domain.dto.ts`, a `*.dto.ts` the CLI bundles under ADR-0046's
 * second exception. The two compose modules alone load no Nest at all.
 */
export { makeValues, fillFileText } from './setup-values';
export type {
  MadeValues,
  RandomSource,
  SetupAnswers,
  ValueProblem,
} from './setup-values';
export { setupDomains } from './setup-domains';
export { composeEnvInputs } from './compose-env-inputs';
export type { SetupDomain } from './setup-domains';
export {
  applyComposeDefaults,
  composeDotenvLine,
  composeEnvHeader,
} from '../../compose/compose-file';
export { publishStackVmPorts } from '../../compose/stack-vm-ports';
export type { HostSide, StackVmRoute } from '../../compose/stack-vm-ports';
