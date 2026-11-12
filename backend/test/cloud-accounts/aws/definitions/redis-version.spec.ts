import { valkeyVersion } from '../../../../src/cloud-accounts/aws/definitions/redis-version';

/**
 * The version rule for a `redis` on ElastiCache (spec "Version
 * rules"): what each written version runs as, from the saved
 * `redis:<version>` image.
 */
describe('valkeyVersion', () => {
  it('runs a major alone as the newest Valkey minor of that major', () => {
    expect(valkeyVersion('redis', 'redis:8')).toEqual({
      ok: true,
      version: {
        written: '8',
        engineVersion: '8.1',
        major: 8,
        parameterFamily: 'valkey8',
        raisedToOldest: false,
        droppedSuffix: null,
      },
    });
  });

  it.each([
    ['8.1', '8.1'],
    ['8.0', '8.0'],
  ])('pins %s', (written, engineVersion) => {
    expect(valkeyVersion('redis', `redis:${written}`)).toMatchObject({
      ok: true,
      version: { written, engineVersion, raisedToOldest: false },
    });
  });

  it.each(['7', '6', '6.2', '5', '7.0'])(
    'runs redis %s as Valkey 7.2, the oldest on AWS, and marks it',
    (written) => {
      expect(valkeyVersion('redis', `redis:${written}`)).toMatchObject({
        ok: true,
        version: {
          written,
          engineVersion: '7.2',
          parameterFamily: 'valkey7',
          raisedToOldest: true,
        },
      });
    },
  );

  it('runs 7.2 as itself, with nothing to note', () => {
    expect(valkeyVersion('redis', 'redis:7.2')).toMatchObject({
      ok: true,
      version: { engineVersion: '7.2', raisedToOldest: false },
    });
  });

  it('drops an image suffix and keeps it for the note', () => {
    expect(valkeyVersion('redis', 'redis:8-alpine')).toMatchObject({
      ok: true,
      version: {
        written: '8-alpine',
        engineVersion: '8.1',
        droppedSuffix: '-alpine',
      },
    });
  });

  it.each(['9', '8.5', '10.0'])(
    'refuses %s, which AWS does not offer, naming what it does',
    (written) => {
      const reading = valkeyVersion('redis', `redis:${written}`);

      expect(reading.ok).toBe(false);
      if (reading.ok) return;
      expect(reading.refusal.at).toBe('redis.version');
      expect(reading.refusal.message).toContain('not offered');
      expect(reading.refusal.message).toContain('7.2, 8.0, 8.1');
    },
  );

  it('refuses a version that is not a number', () => {
    const reading = valkeyVersion('redis', 'redis:latest');

    expect(reading.ok).toBe(false);
  });
});
