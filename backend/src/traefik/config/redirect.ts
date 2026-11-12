import type { HttpMiddleware } from './file-types';

export interface TraefikRedirect {
  uniqueConfigKey: number;
  regex: string;
  replacement: string;
  permanent?: boolean | null;
}

export const redirectMiddlewareName = (
  appName: string,
  uniqueConfigKey: number,
): string => `redirect-${appName}-${uniqueConfigKey}`;

/**
 * Middleware fragment for one redirect row, ready to merge into the shared
 * middlewares config's http.middlewares map.
 */
export const createRedirectMiddleware = (
  appName: string,
  redirect: TraefikRedirect,
): Record<string, HttpMiddleware> => ({
  [redirectMiddlewareName(appName, redirect.uniqueConfigKey)]: {
    redirectRegex: {
      regex: redirect.regex,
      replacement: redirect.replacement,
      permanent: redirect.permanent ?? undefined,
    },
  },
});
