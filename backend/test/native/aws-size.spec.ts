import { AWS_OPEN_SETTINGS } from '../../src/native/aws-open-settings';
import {
  AWS_SIZE_BEARING,
  capsWithNativeFargate,
  fargateWording,
  nativeFargateOf,
  nativeInstanceClassOf,
  rdsMachineText,
} from '../../src/native/aws-size';
import {
  nativeSizesOf,
  pairWording,
  sizeOverrideLine,
  sizeSideOf,
} from '../../src/native/size-override';

/**
 * ADR-0044 rule 12: exact sizes on AWS. A native class, node type
 * or Fargate half wins over `size` on AWS, and the size line names both.
 */
describe('AWS_SIZE_BEARING', () => {
  it('are each open on the lock list, so native can set them', () => {
    const shut = AWS_SIZE_BEARING.settings
      .map((one) => ({ ...one, key: one.path.join('.') }))
      .filter(
        (one) => !(AWS_OPEN_SETTINGS[one.address] ?? []).includes(one.key),
      )
      .map((one) => `${one.address}.${one.key}`);
    expect(shut).toEqual([]);
  });

  it('reads what a block sets, by its path in the file', () => {
    const block = {
      'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
      'aws_ecs_task_definition.service': { cpu: '2048', family: 'x' },
    };

    expect(nativeSizesOf(AWS_SIZE_BEARING, block)).toEqual([
      {
        part: 'machine',
        address: 'aws_db_instance.database',
        value: 'db.r7g.xlarge',
        path: 'native.aws."aws_db_instance.database".instance_class',
      },
      {
        part: 'cpu',
        address: 'aws_ecs_task_definition.service',
        value: '2048',
        path: 'native.aws."aws_ecs_task_definition.service".cpu',
      },
    ]);
    expect(nativeInstanceClassOf(block)).toBe('db.r7g.xlarge');
    expect(nativeInstanceClassOf(undefined)).toBeNull();
  });

  it('names a class with its CPU and memory when the committed table knows it', () => {
    expect(rdsMachineText('db.r7g.xlarge')).toBe('4 vCPU, 32 GB');
    expect(rdsMachineText('db.t4g.micro')).toBe('2 vCPU, 1 GB');
    expect(rdsMachineText('db.x2iedn.xlarge')).toBeNull();
  });

  it('reads a task cpu and memory in each spelling AWS takes', () => {
    const task = (args: Record<string, unknown>) => ({
      'aws_ecs_task_definition.service': args,
    });
    expect(nativeFargateOf(task({ cpu: '2048' }))).toEqual({ cpuUnits: 2048 });
    expect(nativeFargateOf(task({ cpu: '2 vCPU', memory: '4 GB' }))).toEqual({
      cpuUnits: 2048,
      memoryMb: 4096,
    });
    expect(nativeFargateOf(task({ memory: 'lots' }))).toEqual({});
  });
});

describe('sizeOverrideLine and pairWording', () => {
  it('names the size beside the native value it gives way to', () => {
    expect(
      sizeOverrideLine('pg-1', 'medium', 'db.r7g.xlarge', '4 vCPU, 32 GB'),
    ).toBe('pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native');
    expect(sizeOverrideLine('pg-1', null, 'db.x2iedn.xlarge', null)).toBe(
      'pg-1 → db.x2iedn.xlarge, set by native',
    );
  });

  it('marks the half of a pair native sets', () => {
    expect(
      pairWording(
        { text: '2 vCPU', native: true },
        { text: '2 GB', native: false },
      ),
    ).toBe('2 vCPU (native) / 2 GB');
    expect(
      fargateWording(
        { cpuUnits: 1024, memoryMb: 2048 },
        { 'aws_ecs_task_definition.service': { cpu: '2048' } },
      ),
    ).toBe('2 vCPU (native) / 2 GB');
  });
});

describe('sizeSideOf and capsWithNativeFargate', () => {
  it('falls back to the size, or with none to the console on a made Service', () => {
    expect(sizeSideOf(true, true)).toBe('size');
    expect(sizeSideOf(false, true)).toBe('console');
    expect(sizeSideOf(false, false)).toBe('default');
  });

  it('writes the pair a task runs at to the caps of an entry with no size, so it stays there', () => {
    expect(
      capsWithNativeFargate(
        { cpuUnits: 256, memoryMb: 512 },
        { 'aws_ecs_task_definition.service': { cpu: '2048', memory: '4096' } },
      ),
    ).toEqual({
      cpuLimit: String(2e9),
      memoryLimit: String(4 * 1024 * 1024 * 1024),
    });
    expect(
      capsWithNativeFargate({ cpuUnits: 256, memoryMb: 512 }, null),
    ).toBeNull();
  });
});
