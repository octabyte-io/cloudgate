/**
 * Parallel builds per partition are an enterprise feature — without a valid
 * license every partition runs one build at a time. The configured value
 * (web-server settings for the local partition, the server row otherwise)
 * arrives through a port so this stays pure; those sources land with their own
 * phases.
 */

/** DI token for the resolver QueueModule builds from the real sources. */
export const BUILDS_CONCURRENCY = Symbol('BUILDS_CONCURRENCY');

/**
 * How many builds a partition runs at once without a valid license. Stated
 * here rather than inline so `docs/connecting-an-agent.md` can say it and
 * `test/coding-standards/connecting-an-agent-docs.spec.ts` can hold the page
 * to it.
 */
export const UNLICENSED_BUILDS_CONCURRENCY = 1;

export interface QueueLicense {
  hasValidLicense(): Promise<boolean> | boolean;
}

export interface BuildsConcurrencyOptions {
  license: QueueLicense;
  /** Configured builds concurrency for a partition; defaults to 1. */
  configuredConcurrency?: (partition: string) => Promise<number> | number;
}

export const createBuildsConcurrencyResolver =
  (options: BuildsConcurrencyOptions) =>
  async (partition: string): Promise<number> => {
    if (!(await options.license.hasValidLicense())) {
      return UNLICENSED_BUILDS_CONCURRENCY;
    }
    const configured = (await options.configuredConcurrency?.(partition)) ?? 1;
    return Math.max(1, Math.floor(configured));
  };
