/**
 * The backend's Template check (`backend/src/templates/check`), bundled into
 * the CLI from its source so that `cloudgate template check` and an Instance
 * judge a template by one checker (spec #1356, "One checker, three callers"),
 * and `cloudgate template pack` builds the `catalogue.zip` with the same
 * builder the check reads (ADR-0072).
 *
 * The specifier is an alias, not a package: `build.mjs` and
 * `vitest.config.ts` both point it at that directory. It is declared here by
 * hand, and only as far as the CLI uses it, because this package cannot
 * type-check the backend's source: the backend is CommonJS, not strict, and
 * reaches Nest and Drizzle through the Project config parser. ADR-0046's
 * `api-schemas` route would mean moving that whole parser out of the backend,
 * which is its own decision. What keeps this declaration honest is
 * `test/template-check.test.ts`, which runs the real check through it.
 */
declare module 'cloudgate-template-check' {
  import type { InputRule } from 'cloudgate-template-setup';

  /**
   * A Template the check offers, as far as `template try` reads it: its
   * `template.yaml` fields and its compose part's files.
   */
  export interface Template {
    /** The folder name. */
    readonly id: string;
    /** The Config name of the compose entry, when the template has one. */
    readonly compose?: string;
    readonly inputs: Readonly<Record<string, InputRule>>;
    readonly domains: readonly {
      readonly service: string;
      readonly port: number;
      readonly path: string;
    }[];
    readonly files: readonly {
      readonly path: string;
      /** The entry it belongs to; the compose entry when absent. */
      readonly entry?: string;
      readonly mount?: string;
    }[];
    /** `docker-compose.yml` as written; null when there is no compose part. */
    readonly composeFile: string | null;
    /** The files under `files/`, by their path below it. */
    readonly configFiles: Readonly<Record<string, string>>;
  }

  export type CatalogueCheck =
    | {
        readonly ok: true;
        readonly offered: readonly Template[];
        readonly hidden: readonly {
          readonly id: string;
          readonly reason: string;
        }[];
      }
    | { readonly ok: false; readonly reason: string };

  /**
   * The verdict on a `catalogue.zip`'s bytes: the zip refused whole (a
   * legacy `catalogue.json`, an unsafe zip, or one holding a file no template
   * has), or each template offered or hidden with its reason.
   */
  export function checkCatalogue(
    bytes: Uint8Array,
    instance: { readonly cloudgateVersion: string },
  ): CatalogueCheck;

  /** One template folder to publish: its id (the folder name) and files. */
  export interface CatalogueFolder {
    readonly id: string;
    /** The catalogue commit it is published at. */
    readonly revision: string;
    /** By `/`-separated path inside the folder. */
    readonly files: Readonly<Record<string, Uint8Array>>;
  }

  /**
   * The `catalogue.zip` bytes holding `folders`, as a `cg-templates` release
   * publishes them. The website's files are left out; every other file is
   * kept, so the check names a stray one.
   */
  export function encodeCatalogue(
    folders: readonly CatalogueFolder[],
  ): Uint8Array;

  /**
   * Whether a path inside a template folder is the website's (`index.md`,
   * `screenshots/…`), which a folder may hold and a catalogue leaves out.
   */
  export function isWebsiteFile(pathInFolder: string): boolean;

  /**
   * The variables a parsed compose file interpolates, as Docker Compose
   * reads them: those it `needs` (no default) and every one it `mentions`.
   */
  export function composeVariables(document: unknown): {
    readonly needs: ReadonlySet<string>;
    readonly mentions: ReadonlySet<string>;
  };
}

/**
 * The version of the Cloudgate whose check is bundled (`backend/package.json`),
 * stamped in by `build.mjs` and `vitest.config.ts`. A template needing a newer
 * Cloudgate is hidden by this check, as it would be by that Instance.
 */
declare const __CLOUDGATE_CHECK_VERSION__: string;
