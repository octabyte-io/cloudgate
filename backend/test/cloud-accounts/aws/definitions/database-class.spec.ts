import {
  ELASTICACHE_NODE_TYPES,
  RDS_CLASSES,
  formatMachine,
  machineFor,
} from '../../../../src/cloud-accounts/aws/definitions/database-class';
import type { Size } from '../../../../src/project-config';

/**
 * Expected classes come from the spec's rule and AWS's published
 * vCPU and memory for each RDS class, never from the module's own table.
 */
describe('machineFor, on RDS classes', () => {
  it.each([
    ['xsmall', 0.25, 512, 'db.t4g.micro'],
    ['small', 0.5, 1024, 'db.t4g.micro'],
    ['medium', 1, 2048, 'db.t4g.small'],
    ['large', 2, 4096, 'db.t4g.medium'],
    ['xlarge', 4, 8192, 'db.t4g.xlarge'],
    ['2xlarge', 8, 16384, 'db.t4g.2xlarge'],
  ] as const)('puts %s on %s', (name, cpu, memoryMb, expected) => {
    const sizing = machineFor(RDS_CLASSES, 'pg-1', { name, cpu, memoryMb });

    expect(sizing).toMatchObject({
      ok: true,
      sizeName: name,
      smallest: false,
      machine: { name: expected },
    });
  });

  it.each([
    [{ cpu: 2, memoryMb: 1024 }, 'db.t4g.micro'],
    [{ cpu: 1, memoryMb: 12 * 1024 }, 'db.t4g.xlarge'],
    [{ cpu: 3, memoryMb: 512 }, 'db.t4g.xlarge'],
    [{ cpu: 8, memoryMb: 32 * 1024 }, 'db.t4g.2xlarge'],
  ] as const)(
    'puts a custom pair on the smallest class at least as large in both: %o → %s',
    (size: Size, expected) => {
      expect(machineFor(RDS_CLASSES, 'pg-1', size)).toMatchObject({
        ok: true,
        sizeName: null,
        machine: { name: expected },
      });
    },
  );

  it('creates an entry with no size on db.t4g.micro, the smallest', () => {
    expect(machineFor(RDS_CLASSES, 'pg-1', undefined)).toEqual({
      ok: true,
      sizeName: null,
      smallest: true,
      machine: { name: 'db.t4g.micro', vcpu: 2, memoryMb: 1024 },
    });
  });

  it.each([
    { cpu: 16, memoryMb: 1024 },
    { cpu: 1, memoryMb: 64 * 1024 },
  ])(
    'refuses a size above db.m7g.2xlarge, naming the entry and that class: %o',
    (size) => {
      const sizing = machineFor(RDS_CLASSES, 'pg-1', size);

      expect(sizing.ok).toBe(false);
      if (sizing.ok) return;
      expect(sizing.refusal.at).toBe('pg-1.size');
      expect(sizing.refusal.message).toContain('pg-1');
      expect(sizing.refusal.message).toContain(
        'db.m7g.2xlarge (8 vCPU, 32 GB)',
      );
    },
  );

  it('names a class with its CPU and memory as the plan shows it', () => {
    expect(
      formatMachine({ name: 'db.t4g.micro', vcpu: 2, memoryMb: 1024 }),
    ).toBe('2 vCPU, 1 GB');
  });
});

/**
 * The redis table (spec "Size → machine type"): the spec names
 * each size's node type, and AWS publishes each type's memory in hundredths
 * of a GiB, which a plan line shows as published.
 */
describe('machineFor, on ElastiCache node types', () => {
  it.each([
    ['xsmall', 0.25, 512, 'cache.t4g.micro'],
    ['small', 0.5, 1024, 'cache.t4g.small'],
    ['medium', 1, 2048, 'cache.t4g.medium'],
    ['large', 2, 4096, 'cache.m7g.large'],
    ['xlarge', 4, 8192, 'cache.m7g.xlarge'],
    ['2xlarge', 8, 16384, 'cache.m7g.2xlarge'],
  ] as const)('puts %s on %s', (name, cpu, memoryMb, expected) => {
    expect(
      machineFor(ELASTICACHE_NODE_TYPES, 'redis', { name, cpu, memoryMb }),
    ).toMatchObject({ ok: true, sizeName: name, machine: { name: expected } });
  });

  it('creates an entry with no size on cache.t4g.micro, the smallest', () => {
    expect(machineFor(ELASTICACHE_NODE_TYPES, 'redis', undefined)).toEqual({
      ok: true,
      sizeName: null,
      smallest: true,
      machine: expect.objectContaining({ name: 'cache.t4g.micro' }) as object,
    });
  });

  it('refuses a size above cache.m7g.2xlarge, naming it', () => {
    const sizing = machineFor(ELASTICACHE_NODE_TYPES, 'redis', {
      cpu: 16,
      memoryMb: 32 * 1024,
    });

    expect(sizing).toEqual({
      ok: false,
      refusal: {
        at: 'redis.size',
        message: expect.stringContaining(
          'cache.m7g.2xlarge (8 vCPU, 25.01 GB)',
        ) as string,
      },
    });
  });

  it('shows a node type with its memory in hundredths of a GB', () => {
    const sizing = machineFor(ELASTICACHE_NODE_TYPES, 'redis', {
      name: 'small',
      cpu: 0.5,
      memoryMb: 1024,
    });
    if (!sizing.ok) throw new Error('refused');

    expect(formatMachine(sizing.machine)).toBe('2 vCPU, 1.37 GB');
  });
});
