import {
  announcesBuilds,
  expiryAfter,
  REQUESTED_PREVIEWS_NOT_ALLOWED,
  requestedPreviewDescription,
  requestedPreviewInputRefusal,
  requestedPreviewLimitRefusal,
} from '../../src/preview-deployments/requested-preview';

describe('requestedPreviewInputRefusal', () => {
  it.each(['git', 'github', 'gitlab', 'bitbucket', 'gitea'] as const)(
    'admits a %s Application within the maximum',
    (sourceType) => {
      expect(
        requestedPreviewInputRefusal({
          sourceType,
          ttlMinutes: 60,
          maxTtlMinutes: 1440,
        }),
      ).toBeNull();
    },
  );

  it.each(['docker', 'drop', 'raw'] as const)(
    'refuses a %s Application, naming its source type',
    (sourceType) => {
      expect(
        requestedPreviewInputRefusal({
          sourceType,
          ttlMinutes: 60,
          maxTtlMinutes: 1440,
        }),
      ).toEqual({
        code: 'SOURCE_HAS_NO_BRANCH',
        message: `A requested preview builds a branch, and this Application's source type "${sourceType}" has none`,
      });
    },
  );

  it('refuses a TTL over the maximum rather than clamping it, naming the maximum, under a code of its own', () => {
    expect(
      requestedPreviewInputRefusal({
        sourceType: 'github',
        ttlMinutes: 1441,
        maxTtlMinutes: 1440,
      }),
    ).toEqual({
      code: 'TTL_OVER_MAXIMUM',
      message:
        "ttlMinutes is 1441, over this instance's maximum of 1440 minutes",
    });
  });

  it('admits a TTL of exactly the maximum', () => {
    expect(
      requestedPreviewInputRefusal({
        sourceType: 'github',
        ttlMinutes: 1440,
        maxTtlMinutes: 1440,
      }),
    ).toBeNull();
  });
});

describe('expiryAfter', () => {
  it('is now plus the TTL, as an ISO instant', () => {
    expect(expiryAfter(new Date('2026-09-22T10:00:00.000Z'), 90)).toBe(
      '2026-09-22T11:30:00.000Z',
    );
  });
});

describe('requestedPreviewDescription', () => {
  it('names the branch and not who asked', () => {
    expect(requestedPreviewDescription('feature/health')).toBe(
      'Requested preview of feature/health',
    );
  });
});

describe('announcesBuilds', () => {
  it('announces a pull-request preview build and not a requested one', () => {
    expect(announcesBuilds('pullRequest')).toBe(true);
    expect(announcesBuilds('requested')).toBe(false);
  });
});

describe('REQUESTED_PREVIEWS_NOT_ALLOWED', () => {
  it('is the sentence the switch refuses with', () => {
    expect(REQUESTED_PREVIEWS_NOT_ALLOWED).toBe(
      'Requested previews are not allowed on this Application',
    );
  });
});

describe('requestedPreviewLimitRefusal', () => {
  const now = new Date('2026-09-23T10:00:00.000Z');
  const live = (expiresAt: string) => ({ expiresAt, expiredAt: null });

  it('admits while the Application holds fewer than its limit', () => {
    expect(
      requestedPreviewLimitRefusal({
        limit: 3,
        siblings: [
          live('2026-09-23T10:30:00.000Z'),
          live('2026-09-23T11:30:00.000Z'),
        ],
        now,
      }),
    ).toBeNull();
  });

  it('refuses at the limit, naming it, the way out and the soonest expiry, with no finality sentence', () => {
    const refusal = requestedPreviewLimitRefusal({
      limit: 3,
      siblings: [
        live('2026-09-23T11:00:00.000Z'),
        live('2026-09-23T10:30:00.000Z'),
        live('2026-09-23T12:00:00.000Z'),
      ],
      now,
    });

    expect(refusal).toBe(
      "This Application holds at most 3 requested previews at once, and already holds 3. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest expires at 2026-09-23T10:30:00.000Z. This Application's operator sets the limit",
    );
    expect(refusal).not.toMatch(/will not change|access decision/);
  });

  it('says a limit of one in the singular, and refuses a count over a lowered limit', () => {
    expect(
      requestedPreviewLimitRefusal({
        limit: 1,
        siblings: [
          live('2026-09-23T11:00:00.000Z'),
          live('2026-09-23T12:00:00.000Z'),
        ],
        now,
      }),
    ).toBe(
      "This Application holds at most 1 requested preview at once, and already holds 2. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest expires at 2026-09-23T11:00:00.000Z. This Application's operator sets the limit",
    );
  });

  it('names the soonest live sibling past an expired one, marked or not yet swept', () => {
    // A row just deleted (marked, expiry now), and one whose expiry passed
    // before the sweep marked it: both are being torn down, and neither is
    // the expiry a caller can wait for.
    expect(
      requestedPreviewLimitRefusal({
        limit: 3,
        siblings: [
          {
            expiresAt: '2026-09-23T09:58:00.000Z',
            expiredAt: '2026-09-23T09:58:00.000Z',
          },
          live('2026-09-23T09:59:00.000Z'),
          live('2026-09-23T10:45:00.000Z'),
        ],
        now,
      }),
    ).toBe(
      "This Application holds at most 3 requested previews at once, and already holds 3. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest expires at 2026-09-23T10:45:00.000Z. This Application's operator sets the limit",
    );
  });

  it('says every sibling is expired and being torn down only when every one is, rather than promising a past instant', () => {
    expect(
      requestedPreviewLimitRefusal({
        limit: 2,
        siblings: [
          {
            expiresAt: '2026-09-23T09:59:00.000Z',
            expiredAt: '2026-09-23T09:59:00.000Z',
          },
          live('2026-09-23T09:50:00.000Z'),
        ],
        now,
      }),
    ).toBe(
      "This Application holds at most 2 requested previews at once, and already holds 2. Deleting one expires it now, and its slot frees once its teardown finishes; the soonest already expired at 2026-09-23T09:50:00.000Z and is being torn down. This Application's operator sets the limit",
    );
  });
});
