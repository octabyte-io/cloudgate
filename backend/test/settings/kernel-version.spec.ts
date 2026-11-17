import {
  kernelVersionText,
  mongoRefusesKernel,
  upstreamKernelVersion,
} from '../../src/settings/kernel-version';

/** The version a host's answer names, written out, or null. */
const read = (answer: string): string | null => {
  const version = upstreamKernelVersion(answer);
  return version === null ? null : kernelVersionText(version);
};

/** Whether MongoDB 8 refuses the kernel this answer names. */
const refuses = (answer: string): boolean => {
  const version = upstreamKernelVersion(answer);
  if (version === null) throw new Error(`no version in ${answer}`);
  return mongoRefusesKernel(version);
};

describe('upstreamKernelVersion', () => {
  it("reads Ubuntu's upstream version off the last field of its signature, not off its package's version", () => {
    // Both measured on Ubuntu 26.04 on 2026-11-17: `uname -r` was
    // `7.0.0-30-generic` and `7.0.0-43-generic`, the same 7.0.0 for both.
    expect(read('Ubuntu 7.0.0-30.30-generic 7.0.12')).toBe('7.0.12');
    expect(read('Ubuntu 7.0.0-43.43-generic 7.0.14\n')).toBe('7.0.14');
    expect(read('Ubuntu 6.8.0-31.31-generic 6.8.1')).toBe('6.8.1');
  });

  it("reads the leading version off uname's release where there is no signature", () => {
    expect(read('6.19.3-arch1-1')).toBe('6.19.3');
    expect(read('7.0.14-200.fc43.x86_64')).toBe('7.0.14');
    expect(read('Linux 6.8.0-31-generic')).toBe('6.8.0');
    expect(read('6.12.0+deb13-amd64')).toBe('6.12.0');
  });

  it('takes a kernel with no patch number as patch 0', () => {
    expect(read('7.1-rc2')).toBe('7.1.0');
  });

  it('names no version for an answer that carries none', () => {
    expect(read('')).toBeNull();
    expect(read('   ')).toBeNull();
    expect(read('sh: 1: uname: not found')).toBeNull();
    expect(read('Ubuntu 7.0.0-30.30-generic')).toBeNull();
    expect(read('7')).toBeNull();
  });
});

describe('mongoRefusesKernel', () => {
  it('refuses 6.19.0 through 7.0.13, both ends included', () => {
    expect(refuses('6.19.0')).toBe(true);
    expect(refuses('6.19.7')).toBe(true);
    expect(refuses('Ubuntu 7.0.0-30.30-generic 7.0.12')).toBe(true);
    expect(refuses('7.0.13')).toBe(true);
  });

  it('starts on a kernel either side of the range', () => {
    expect(refuses('6.18.12')).toBe(false);
    expect(refuses('Ubuntu 6.8.0-138.138-generic 6.8.12')).toBe(false);
    expect(refuses('6.8.0-138-generic')).toBe(false);
    expect(refuses('Ubuntu 7.0.0-43.43-generic 7.0.14')).toBe(false);
    expect(refuses('7.2.11')).toBe(false);
    expect(refuses('5.15.0-131-generic')).toBe(false);
  });
});
