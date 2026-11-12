import { describe, expect, it } from 'vitest';

import { serverVersionAgainst } from '../src/server-version.js';

describe('serverVersionAgainst', () => {
  it('accepts the minimum itself', () => {
    expect(serverVersionAgainst('0.4.0', '0.4.0')).toBe('supported');
  });

  it('accepts a newer Instance, by number rather than by text', () => {
    expect(serverVersionAgainst('0.10.0', '0.9.3')).toBe('supported');
    expect(serverVersionAgainst('1.0.0', '0.9.3')).toBe('supported');
    expect(serverVersionAgainst('0.9.10', '0.9.3')).toBe('supported');
  });

  it('calls an older Instance older', () => {
    expect(serverVersionAgainst('0.0.1', '0.1.0')).toBe('older');
    expect(serverVersionAgainst('0.9.2', '0.9.10')).toBe('older');
    expect(serverVersionAgainst('0.9.3', '1.0.0')).toBe('older');
  });

  it('orders a pre-release before its release, and ignores build metadata', () => {
    expect(serverVersionAgainst('1.0.0-rc.1', '1.0.0')).toBe('older');
    expect(serverVersionAgainst('1.0.1-rc.1', '1.0.0')).toBe('supported');
    expect(serverVersionAgainst('1.0.0+abc123', '1.0.0')).toBe('supported');
    expect(serverVersionAgainst('v1.2.3', '1.2.3')).toBe('supported');
  });

  it('calls a version that is not MAJOR.MINOR.PATCH unreadable', () => {
    for (const version of ['', 'latest', '1.2', '1.2.x']) {
      expect(serverVersionAgainst(version, '0.0.1')).toBe('unreadable');
    }
  });
});
