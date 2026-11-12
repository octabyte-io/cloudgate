import type { HttpMiddleware } from './file-types';

export const securityMiddlewareName = (appName: string): string =>
  `auth-${appName}`;

/**
 * Basic-auth middleware fragment for the shared middlewares config. Users
 * are `name:hashed-password` strings — hashing is the security phase's
 * job, generators stay pure.
 */
export const createBasicAuthMiddleware = (
  appName: string,
  users: string[],
): Record<string, HttpMiddleware> => ({
  [securityMiddlewareName(appName)]: {
    basicAuth: {
      removeHeader: true,
      users,
    },
  },
});
