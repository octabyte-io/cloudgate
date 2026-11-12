import { createBuildsConcurrencyResolver } from '../../src/deployment-queue/concurrency';

describe('createBuildsConcurrencyResolver', () => {
  it('clamps concurrency to 1 without a valid license, even when configured higher', async () => {
    const resolve = createBuildsConcurrencyResolver({
      license: { hasValidLicense: () => false },
      configuredConcurrency: () => 4,
    });

    expect(await resolve('srv-1')).toBe(1);
  });

  it('resolves the configured concurrency of the partition when licensed', async () => {
    const resolve = createBuildsConcurrencyResolver({
      license: { hasValidLicense: () => true },
      configuredConcurrency: (partition) => (partition === 'srv-big' ? 3 : 1),
    });

    expect(await resolve('srv-big')).toBe(3);
    expect(await resolve('srv-small')).toBe(1);
  });

  it('never resolves below 1, whatever is configured', async () => {
    const resolve = createBuildsConcurrencyResolver({
      license: { hasValidLicense: () => true },
      configuredConcurrency: () => 0,
    });

    expect(await resolve('srv-1')).toBe(1);
  });
});
