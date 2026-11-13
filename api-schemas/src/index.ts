/**
 * The zod schemas the backend and the Cloudgate CLI share (ADR 0046).
 *
 * Plain zod and nothing else: a schema here must bundle into the CLI, so it
 * may not import `nestjs-zod`, `@nestjs/*` or anything from `backend/src`. The
 * backend wraps what it needs in `createZodDto` where it uses it. A schema
 * moves here in the build slice that first needs it on both sides; there is no
 * up-front migration.
 */
export * from './about';
export * from './device-login';
export * from './errors';
export * from './users';
export * from './targets';
export * from './plans';
export * from './status';
export * from './variables';
export * from './deployments';
export * from './drops';
export * from './logs';
export * from './return-to';
export * from './new-project';
