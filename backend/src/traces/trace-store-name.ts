// What a Trace store's container is called, in a file that imports
// nothing, so the platform-container rule (`realtime/container-access.service.ts`)
// can read the prefix without pulling the store's machine code in.

/**
 * Every store's container name starts with this. It carries `cloudgate`, so
 * the container routes, sockets and swarm routes refuse it by the existing
 * platform-container rule (`isPlatformContainerName`), which also refuses this
 * prefix by name: an `appName` carrying `cloudgate-monitoring` would otherwise
 * have been the one exception that rule carves out.
 */
export const TRACE_STORE_CONTAINER_PREFIX = 'cloudgate-trace-store-';

/**
 * The store's container name on its Server, and its host name on the network:
 * the prefix, the Service's kind, then its `appName`. The kind is in it
 * because `appName` is unique within the Application table and within the
 * Compose table but not across them, and two stores of one name would start,
 * restart and remove each other's container. With it, an Application `shop`
 * and a Compose `shop` have two stores, and no kind's name can be another's:
 * each starts with its kind and a hyphen.
 */
export const traceStoreContainerName = (owner: {
  serviceType: 'application' | 'compose';
  appName: string;
}): string =>
  `${TRACE_STORE_CONTAINER_PREFIX}${owner.serviceType}-${owner.appName}`;
