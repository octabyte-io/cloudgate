import {
  cardIdsFromNvidiaSmi,
  gpuSetupOf,
  qualifiesAsGpuServer,
} from '../../src/settings/gpu-setup-state';

describe('gpuSetupOf', () => {
  it('reads a node advertising nothing as not set up', () => {
    expect(gpuSetupOf('null\n')).toEqual({
      gpuSetup: 'none',
      gpuCardIds: [],
      gpuResources: 0,
    });
    expect(gpuSetupOf('')).toEqual({
      gpuSetup: 'none',
      gpuCardIds: [],
      gpuResources: 0,
    });
  });

  it('reads a node advertising only non-GPU resources as not set up', () => {
    expect(
      gpuSetupOf('[{"DiscreteResourceSpec":{"Kind":"SSD","Value":1}}]'),
    ).toMatchObject({ gpuSetup: 'none', gpuResources: 0 });
  });

  it('reads a GPU count as set up the old way', () => {
    expect(
      gpuSetupOf('[{"DiscreteResourceSpec":{"Kind":"GPU","Value":2}}]\n'),
    ).toEqual({ gpuSetup: 'count', gpuCardIds: [], gpuResources: 2 });
  });

  it('reads one named GPU per card as set up by card ID', () => {
    expect(
      gpuSetupOf(
        '[{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-a1"}},' +
          '{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-b2"}}]',
      ),
    ).toEqual({
      gpuSetup: 'card-id',
      gpuCardIds: ['GPU-a1', 'GPU-b2'],
      gpuResources: 2,
    });
  });

  it('reads unparseable output as not set up', () => {
    expect(gpuSetupOf('Error: This node is not a swarm manager')).toEqual({
      gpuSetup: 'none',
      gpuCardIds: [],
      gpuResources: 0,
    });
  });
});

describe('qualifiesAsGpuServer', () => {
  it('admits only a machine set up by card ID', () => {
    expect(qualifiesAsGpuServer('card-id')).toBe(true);
    expect(qualifiesAsGpuServer('count')).toBe(false);
    expect(qualifiesAsGpuServer('none')).toBe(false);
  });
});

describe('cardIdsFromNvidiaSmi', () => {
  it('reads one card ID per line', () => {
    expect(
      cardIdsFromNvidiaSmi(
        'GPU-8f3c1a2b-0d4e-4f5a-9b6c-7d8e9f0a1b2c\nGPU-11111111-2222-3333-4444-555555555555\n',
      ),
    ).toEqual([
      'GPU-8f3c1a2b-0d4e-4f5a-9b6c-7d8e9f0a1b2c',
      'GPU-11111111-2222-3333-4444-555555555555',
    ]);
  });

  it('refuses a line that is not a card ID, so nothing unexpected reaches the setup command', () => {
    expect(() => cardIdsFromNvidiaSmi("GPU-abc\nGPU-x'; reboot #\n")).toThrow(
      "nvidia-smi answered a card ID Cloudgate does not recognise: GPU-x'; reboot #",
    );
  });

  it('refuses a machine with no card', () => {
    expect(() => cardIdsFromNvidiaSmi('\n')).toThrow(
      'nvidia-smi lists no GPU on this machine',
    );
  });
});
