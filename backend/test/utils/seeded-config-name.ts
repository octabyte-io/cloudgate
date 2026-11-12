import { customAlphabet } from 'nanoid';

const suffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

/**
 * A Config name for a Service row a suite inserts directly rather than through
 * its create route. The column is non-null and unique within an
 * Environment, and a direct insert skips `mintServiceConfigName`, so a seed
 * passes one of these: valid, and distinct from every other seed's.
 */
export const seededConfigName = (): string => `seeded-${suffix()}`;
