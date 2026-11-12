import type { FileConfig, HttpMiddleware } from './file-types';
import type { TraefikDomain } from './types';

export const addPrefixMiddlewareName = (
  appName: string,
  uniqueConfigKey: number,
): string => `addprefix-${appName}-${uniqueConfigKey}`;

export const stripPrefixMiddlewareName = (
  appName: string,
  uniqueConfigKey: number,
): string => `stripprefix-${appName}-${uniqueConfigKey}`;

/**
 * Path-rewriting middleware fragments for one domain: stripPrefix drops
 * the public path, addPrefix prepends the internal one. Empty when the
 * domain needs neither.
 */
export const createPathMiddlewares = (
  appName: string,
  domain: TraefikDomain,
): Record<string, HttpMiddleware> => {
  const { uniqueConfigKey, internalPath, stripPath, path } = domain;
  const fragment: Record<string, HttpMiddleware> = {};

  if (internalPath && internalPath !== '/' && internalPath !== path) {
    fragment[addPrefixMiddlewareName(appName, uniqueConfigKey)] = {
      addPrefix: { prefix: internalPath },
    };
  }

  if (stripPath && path && path !== '/') {
    fragment[stripPrefixMiddlewareName(appName, uniqueConfigKey)] = {
      stripPrefix: { prefixes: [path] },
    };
  }

  return fragment;
};

/** Attaches the middleware to every router in the config (idempotent). */
export const addMiddleware = (
  config: FileConfig,
  middlewareName: string,
): void => {
  for (const router of Object.values(config.http?.routers ?? {})) {
    router.middlewares = router.middlewares ?? [];
    if (!router.middlewares.includes(middlewareName)) {
      router.middlewares.push(middlewareName);
    }
  }
};

/** Detaches the middleware from every router that lists it. */
export const deleteMiddleware = (
  config: FileConfig,
  middlewareName: string,
): void => {
  for (const router of Object.values(config.http?.routers ?? {})) {
    if (router.middlewares) {
      router.middlewares = router.middlewares.filter(
        (name) => name !== middlewareName,
      );
    }
  }
};
