import { addDomainToConfig } from './domain';
import type { FileConfig } from './file-types';
import type { TraefikApp, TraefikDomain } from './types';

/**
 * Builds the complete dynamic config for an application from its domains.
 */
export const createTraefikConfig = (
  app: TraefikApp,
  domains: TraefikDomain[],
): FileConfig => {
  const config: FileConfig = { http: { routers: {}, services: {} } };
  for (const domain of domains) {
    addDomainToConfig(config, app, domain);
  }
  return config;
};
