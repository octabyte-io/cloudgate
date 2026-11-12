import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { gitProviderOauthState } from '../db/schema';
import type {
  GitProviderOauthPurpose,
  GitProviderOauthState,
  GitProviderType,
} from '../db/schema';

/**
 * Issues and redeems the `state` a git-provider handshake is carried on.
 *
 * The callback routes are unauthenticated by necessity — a provider redirects a
 * browser to them — so the `state` carries the whole authority to write a
 * credential onto a connection. Three properties make that safe, and each is
 * enforced here rather than at the call sites:
 *
 * 1. **Unguessable** — a nanoid, not the connection's own id (anyone who has
 *    ever seen a row id could forge a callback for it).
 * 2. **Single use** — `consume` *deletes* the row it returns, in one statement,
 *    so a replayed callback finds nothing.
 * 3. **Narrow** — a state is good for exactly one provider kind and one leg of
 *    one handshake, so a manifest state cannot stand in for an install state.
 */
@Injectable()
export class GitProviderOauthStateService {
  /** How long a handshake may sit half-finished. A user is at the provider. */
  static readonly TTL_SECONDS = 15 * 60;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async issue(params: {
    purpose: GitProviderOauthPurpose;
    providerType: GitProviderType;
    gitProviderId: string;
    returnTo: string;
    redirectUri?: string | null;
  }): Promise<GitProviderOauthState> {
    const [created] = await this.db
      .insert(gitProviderOauthState)
      .values({
        purpose: params.purpose,
        providerType: params.providerType,
        gitProviderId: params.gitProviderId,
        returnTo: params.returnTo,
        redirectUri: params.redirectUri ?? null,
        expiresAt:
          Math.floor(Date.now() / 1000) +
          GitProviderOauthStateService.TTL_SECONDS,
      })
      .returning();
    return created;
  }

  /**
   * Redeems a state, or refuses. The delete-and-return is what makes it single
   * use: two concurrent replays of the same callback cannot both find the row.
   *
   * Every refusal is a 400 with the same wording whatever went wrong — an
   * unknown state, a replayed one, an expired one and one issued for another
   * provider are indistinguishable from outside, which is the point.
   */
  async consume(
    state: string | undefined,
    expected: {
      purpose: GitProviderOauthPurpose;
      providerType: GitProviderType;
    },
  ): Promise<GitProviderOauthState> {
    if (!state) throw this.refusal();
    const [row] = await this.db
      .delete(gitProviderOauthState)
      .where(eq(gitProviderOauthState.state, state))
      .returning();
    if (!row) throw this.refusal();
    if (
      row.purpose !== expected.purpose ||
      row.providerType !== expected.providerType
    ) {
      throw this.refusal();
    }
    if (row.expiresAt < Math.floor(Date.now() / 1000)) throw this.refusal();
    return row;
  }

  private refusal(): BadRequestException {
    return new BadRequestException(
      'This connection attempt is not one Cloudgate is waiting for. It may have expired, or already been completed — start connecting again.',
    );
  }
}
