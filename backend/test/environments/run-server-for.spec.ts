import { BadRequestException } from '@nestjs/common';
import {
  CLOUD_TARGET_NEEDS_SERVER,
  refuseUnchosenInCloud,
  runServerFor,
} from '../../src/environments/deploy-target';
import type { PlatformHostRule } from '../../src/environments/deploy-target';
import {
  PLATFORM_HOST_REFUSALS,
  platformHostRefused,
} from '../../src/instance-mode/platform-host-refusal';

/** A Self-hosted instance: the platform host is a place like any other. */
const selfHosted: PlatformHostRule = { refusePlatformHost: () => undefined };
/** The Hosted instance, as `InstanceMode.refusePlatformHost` answers there. */
const hosted: PlatformHostRule = {
  refusePlatformHost: (work) => {
    throw platformHostRefused(work);
  },
};
const inCloud = {
  kind: 'cloud' as const,
  cloudAccountId: 'ca_1',
  region: 'eu-west-1',
};

/**
 * Where a console create lands when its body names no Server: an
 * operator who set the Environment's Deploy target to a Server got
 * Applications on the platform host unless they noticed the picker.
 */
describe('runServerFor', () => {
  const onServer = { kind: 'server' as const, serverId: 'srv_1' };

  it('takes the Deploy target Server when the body names none', () => {
    expect(runServerFor(undefined, onServer, selfHosted)).toBe('srv_1');
  });

  it('keeps a Server the body names over the Deploy target', () => {
    expect(runServerFor('srv_2', onServer, selfHosted)).toBe('srv_2');
  });

  it('keeps the platform host when the body chose it with null', () => {
    expect(runServerFor(null, onServer, selfHosted)).toBeNull();
  });

  it('lands on the platform host when that is the Deploy target', () => {
    expect(
      runServerFor(undefined, { kind: 'platform-host' }, selfHosted),
    ).toBeNull();
  });

  describe('in a Cloud account, which only a plan creates in', () => {
    it('asks for a Server rather than landing on the platform host', () => {
      expect(() => runServerFor(undefined, inCloud, selfHosted)).toThrow(
        new BadRequestException(CLOUD_TARGET_NEEDS_SERVER),
      );
    });

    it('keeps the platform host chosen on purpose with null, or a named Server', () => {
      expect(runServerFor(null, inCloud, selfHosted)).toBeNull();
      expect(runServerFor('srv_2', inCloud, selfHosted)).toBe('srv_2');
    });
  });

  describe('refuseUnchosenInCloud, the seam every console create asks', () => {
    it('refuses only a left-out Server in a Cloud-account Environment', () => {
      expect(() => refuseUnchosenInCloud(undefined, inCloud)).toThrow(
        CLOUD_TARGET_NEEDS_SERVER,
      );
      expect(() => refuseUnchosenInCloud(null, inCloud)).not.toThrow();
      expect(() => refuseUnchosenInCloud('srv_2', inCloud)).not.toThrow();
      for (const target of [
        { kind: 'platform-host' as const },
        { kind: 'server' as const, serverId: 'srv_1' },
      ]) {
        expect(() => refuseUnchosenInCloud(undefined, target)).not.toThrow();
      }
    });
  });

  describe('on the Hosted instance (ADR-0053 seam 2)', () => {
    it('refuses the platform host a platform-host or Cloud-account target would give', () => {
      for (const target of [{ kind: 'platform-host' as const }, inCloud]) {
        expect(() => runServerFor(undefined, target, hosted)).toThrow(
          PLATFORM_HOST_REFUSALS.services,
        );
      }
    });

    it("still takes the Deploy target's Server, or the one the body names", () => {
      expect(runServerFor(undefined, onServer, hosted)).toBe('srv_1');
      expect(runServerFor('srv_2', inCloud, hosted)).toBe('srv_2');
    });
  });
});
