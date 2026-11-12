import { ConflictException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  admitPreviewDnsChallenge,
  dnsChallengeWildcardOf,
} from '../../src/preview-deployments/preview-dns-challenge';
import type { DnsChallengeParent } from '../../src/preview-deployments/preview-dns-challenge';

/** Written out, so a reworded refusal is a decision rather than a drift. */
const NEEDS_WILDCARD =
  'Issuing preview certificates through DNS-01 needs a preview wildcard: a generated sslip.io host cannot get a DNS-01 certificate. Set a preview wildcard, or turn DNS-01 off in the same save before clearing it';
const NO_SETUP =
  "The machine this Application's previews run on has no DNS-01 setup. Add a DNS provider in that machine's Traefik settings first";

const stored = (
  over: Partial<DnsChallengeParent> = {},
): DnsChallengeParent => ({
  serverId: 'srv-1',
  previewWildcard: '*.preview.example.com',
  previewDnsChallenge: false,
  ...over,
});

/** A database whose only table is the machine's DNS-01 row, or none. */
const dbWith = (row: object | undefined) => {
  const limit = jest.fn().mockResolvedValue(row ? [row] : []);
  const chain = { from: () => chain, where: () => chain, limit };
  return { db: { select: () => chain } as unknown as DrizzleDB, limit };
};

/** The refusal's status, body sentence and code, or null when admitted. */
async function refusal(
  db: DrizzleDB,
  current: DnsChallengeParent,
  data: Parameters<typeof admitPreviewDnsChallenge>[2],
) {
  try {
    await admitPreviewDnsChallenge(db, current, data);
    return null;
  } catch (error) {
    if (!(error instanceof ConflictException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

describe('admitPreviewDnsChallenge', () => {
  it('admits turning the switch on with a wildcard and a DNS-01 setup on the machine', async () => {
    const { db, limit } = dbWith({ dnsChallengeId: 'dns-1' });
    await expect(
      refusal(db, stored(), { previewDnsChallenge: true }),
    ).resolves.toBeNull();
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('refuses turning the switch on with no preview wildcard stored, 409', async () => {
    const { db } = dbWith({ dnsChallengeId: 'dns-1' });
    await expect(
      refusal(db, stored({ previewWildcard: null }), {
        previewDnsChallenge: true,
      }),
    ).resolves.toEqual({
      status: 409,
      body: {
        message: NEEDS_WILDCARD,
        code: 'PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD',
      },
    });
  });

  it('refuses turning it on and clearing the wildcard in one save', async () => {
    const { db } = dbWith({ dnsChallengeId: 'dns-1' });
    await expect(
      refusal(db, stored(), {
        previewDnsChallenge: true,
        previewWildcard: null,
      }),
    ).resolves.toMatchObject({ status: 409 });
  });

  it('refuses clearing the wildcard while the switch stays on, rather than turning it off', async () => {
    const { db, limit } = dbWith({ dnsChallengeId: 'dns-1' });
    await expect(
      refusal(db, stored({ previewDnsChallenge: true }), {
        previewWildcard: null,
      }),
    ).resolves.toEqual({
      status: 409,
      body: {
        message: NEEDS_WILDCARD,
        code: 'PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD',
      },
    });
    // Not a question about the machine at all.
    expect(limit).not.toHaveBeenCalled();
  });

  it('admits clearing the wildcard in the same save that turns the switch off', async () => {
    const { db } = dbWith(undefined);
    await expect(
      refusal(db, stored({ previewDnsChallenge: true }), {
        previewDnsChallenge: false,
        previewWildcard: null,
      }),
    ).resolves.toBeNull();
  });

  it("refuses turning the switch on when the Application's machine has no DNS-01 setup, 409", async () => {
    const { db, limit } = dbWith(undefined);
    await expect(
      refusal(db, stored(), { previewDnsChallenge: true }),
    ).resolves.toEqual({
      status: 409,
      body: { message: NO_SETUP, code: 'NO_DNS_CHALLENGE_ON_MACHINE' },
    });
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('asks the platform host for its DNS-01 setup when the Application has no Server', async () => {
    const { db } = dbWith(undefined);
    await expect(
      refusal(db, stored({ serverId: null }), { previewDnsChallenge: true }),
    ).resolves.toMatchObject({
      body: { code: 'NO_DNS_CHALLENGE_ON_MACHINE' },
    });
  });

  it('does not refuse a save of other fields over the machine, and does not ask it', async () => {
    const { db, limit } = dbWith(undefined);
    await expect(
      refusal(db, stored({ previewDnsChallenge: true }), {
        previewWildcard: '*.pr.example.com',
      }),
    ).resolves.toBeNull();
    await expect(refusal(db, stored(), {})).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('admits turning the switch off whatever the machine has', async () => {
    const { db } = dbWith(undefined);
    await expect(
      refusal(
        db,
        stored({ previewDnsChallenge: true, previewWildcard: null }),
        {
          previewDnsChallenge: false,
        },
      ),
    ).resolves.toBeNull();
  });
});

describe('dnsChallengeWildcardOf', () => {
  it('is the preview wildcard while the switch is on, and null while it is off', () => {
    expect(
      dnsChallengeWildcardOf({
        previewDnsChallenge: true,
        previewWildcard: '*.preview.example.com',
      }),
    ).toBe('*.preview.example.com');
    expect(
      dnsChallengeWildcardOf({
        previewDnsChallenge: false,
        previewWildcard: '*.preview.example.com',
      }),
    ).toBeNull();
  });
});
