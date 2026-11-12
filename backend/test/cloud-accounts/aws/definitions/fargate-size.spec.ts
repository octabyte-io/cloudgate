import { fargateSize } from '../../../../src/cloud-accounts/aws/definitions/fargate-size';
import type { Size } from '../../../../src/project-config';

/**
 * Expected pairs come from the spec's table ("Sizes on Fargate") and
 * from AWS's published list of Fargate CPU and memory combinations, never from
 * the module's own table.
 */
describe('fargateSize', () => {
  describe('a named size', () => {
    it.each([
      ['xsmall', 0.25, 512, 256, 512],
      ['small', 0.5, 1024, 512, 1024],
      ['medium', 1, 2048, 1024, 2048],
      ['large', 2, 4096, 2048, 4096],
      ['xlarge', 4, 8192, 4096, 8192],
      ['2xlarge', 8, 16384, 8192, 16384],
    ] as const)(
      'maps %s exactly onto its Fargate pair',
      (name, cpu, memoryMb, cpuUnits, fargateMemoryMb) => {
        const size: Size = { name, cpu, memoryMb };

        expect(fargateSize('api', size)).toEqual({
          ok: true,
          sizeName: name,
          pair: { cpuUnits, memoryMb: fargateMemoryMb },
        });
      },
    );
  });

  describe('no size', () => {
    it("creates an entry with no size at xsmall's pair", () => {
      expect(fargateSize('api', undefined)).toEqual({
        ok: true,
        sizeName: null,
        pair: { cpuUnits: 256, memoryMb: 512 },
      });
    });
  });

  describe('a custom pair', () => {
    it.each([
      // An allowed pair is kept as it is.
      [0.25, 2048, 256, 2048],
      [4, 30720, 4096, 30720],
      // Memory rounds up inside the CPU's own range.
      [0.25, 600, 256, 1024],
      [1, 2500, 1024, 3072],
      [2, 9000, 2048, 9216],
      // Memory past the CPU's range moves up a CPU step.
      [0.25, 3072, 512, 3072],
      [1, 9216, 2048, 9216],
      [4, 32768, 8192, 32768],
      // CPU rounds up; memory then starts at that CPU's least.
      [0.3, 512, 512, 1024],
      [3, 1024, 4096, 8192],
      [8.5, 1024, 16384, 32768],
      // Above 8 vCPU memory comes in 4 GB, then 8 GB, steps.
      [8, 17000, 8192, 20480],
      [16, 33000, 16384, 40960],
      // Fargate's largest pair.
      [16, 122880, 16384, 122880],
    ])(
      'maps %s CPU / %s MB to the smallest allowed pair at least as large in both',
      (cpu, memoryMb, cpuUnits, fargateMemoryMb) => {
        expect(fargateSize('api', { cpu, memoryMb })).toEqual({
          ok: true,
          sizeName: null,
          pair: { cpuUnits, memoryMb: fargateMemoryMb },
        });
      },
    );

    it.each([
      [16.5, 1024],
      [32, 65536],
      [1, 123904],
      [16, 131072],
    ])(
      "refuses %s CPU / %s MB as above Fargate's largest pair, naming the entry",
      (cpu, memoryMb) => {
        const result = fargateSize('api', { cpu, memoryMb });

        expect(result).toEqual({
          ok: false,
          refusal: { at: 'api.size', message: expect.any(String) as string },
        });
        if (result.ok) return;
        expect(result.refusal.message).toContain('api');
        expect(result.refusal.message).toContain('16 vCPU / 120 GB');
      },
    );
  });
});
