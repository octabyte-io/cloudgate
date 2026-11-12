declare const __CLOUDGATE_VERSION__: string;

/**
 * This CLI's version: its own `package.json` version, stamped in at bundle
 * time by `build.mjs` (and by `vitest.config.ts` for the unit lane), so the
 * CLI never reads a file at run time to know what it is. It is the CLI's
 * version and never the server's (CLI spec).
 */
export const VERSION: string = __CLOUDGATE_VERSION__;
