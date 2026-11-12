/**
 * What an Instance does to a Template's compose part at setup
 * (`backend/src/templates/setup/cli-bundle.ts`): the values made once at
 * setup, config files filled in with them, the Domains' setup names, and the
 * compose file preparation. Bundled into the CLI from its source, as the
 * Template check is (`template-check.d.ts`), so that `cloudgate template try`
 * prepares a Template as an Instance does (spec #5).
 *
 * The specifier is an alias, not a package: `build.mjs` and
 * `vitest.config.ts` both point it at that file. It is declared here by
 * hand, and only as far as the CLI uses it, for the reason
 * `template-check.d.ts` gives. What keeps this declaration honest is
 * `test/template-setup.test.ts`, which runs the real code through it.
 */
declare module 'cloudgate-template-setup' {
  /** One input's rule in `template.yaml`, as the Template check read it. */
  export type InputRule =
    | {
        readonly generate: 'password' | 'hex' | 'base64' | 'uuid' | 'jwt';
      }
    | {
        readonly generate: 'jwt';
        /** The input whose value signs it (HS256). */
        readonly secret: string;
        readonly payload: Readonly<Record<string, unknown>>;
      }
    | {
        readonly ask: {
          readonly label: string;
          readonly description?: string;
          readonly default?: string;
          /** True when not written. */
          readonly required?: boolean;
          readonly secret?: boolean;
          readonly format?: 'email' | 'url' | 'number';
          readonly pattern?: string;
        };
      }
    | { readonly value: string };

  /**
   * What a setup answered: an asked value by input name, and a Domain's URL
   * or host by `{{domains.<name>.…}}` name, `null` when it has none.
   */
  export interface SetupAnswers {
    readonly asked: Readonly<Record<string, string>>;
    readonly domain: (name: string, part: 'url' | 'host') => string | null;
  }

  /** Why one input has no value: named by the input. */
  export interface ValueProblem {
    readonly input: string;
    readonly message: string;
  }

  export type MadeValues =
    | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
    | { readonly ok: false; readonly problems: readonly ValueProblem[] };

  /** The random source values are drawn from: `node:crypto` unless pinned. */
  export interface RandomSource {
    bytes(n: number): Buffer;
    /** A random integer in [0, max). */
    below(max: number): number;
    uuid(): string;
  }

  /**
   * Every input's value, or every problem with what was asked, as setup
   * makes them (ADR-0064). Assumes the Template check passed: it refused a
   * loop, an unknown reference and a jwt signed with no input.
   */
  export function makeValues(
    inputs: Readonly<Record<string, InputRule>>,
    answers: SetupAnswers,
    random?: RandomSource,
  ): MadeValues;

  /**
   * A config file's text with each `{{domains.<name>.url|host}}` and each
   * `{{NAME}}` naming one of `values` filled in; any other `{{…}}` is the
   * file's own and stays.
   */
  export function fillFileText(
    text: string,
    answers: Pick<SetupAnswers, 'domain'>,
    values: Readonly<Record<string, string>>,
  ): string;

  /** One compose Domain under the name its host goes by at setup. */
  export interface SetupDomain {
    /** The service, or `<service>#n` for a service with two Domains. */
    readonly name: string;
    readonly service: string;
    readonly port: number;
    readonly path: string;
  }

  /** A Template's compose Domains, in `template.yaml`'s order. */
  export function setupDomains(template: {
    readonly domains: readonly {
      readonly service: string;
      readonly port: number;
      readonly path: string;
    }[];
  }): SetupDomain[];

  /** A compose file, as far as the platform defaults touch it. */
  export interface ComposeSpecification {
    services?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  }

  /**
   * The restart policy (`docker-compose` only) and log limits Cloudgate
   * writes into a converted compose file, on each service that is silent
   * about them. The log limits are read from `env`.
   */
  export function applyComposeDefaults(
    compose: { readonly composeType: 'docker-compose' | 'stack' },
    spec: ComposeSpecification,
    env?: NodeJS.ProcessEnv,
  ): ComposeSpecification;

  /** One `KEY=value` line of a stack's `.env`, as Compose reads it back. */
  export function composeDotenvLine(line: string): string;

  /** A compose service's Domain, as a Stack VM's deploy publishes it. */
  export interface StackVmRoute {
    readonly host: string;
    readonly serviceName: string;
    readonly port: number;
  }

  /**
   * The compose file with each Domain's container port published at the
   * same number; refuses a Domain on a service the file does not declare.
   */
  export function publishStackVmPorts(
    content: string,
    routes: readonly StackVmRoute[],
  ): string;
}
