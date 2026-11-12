import { defaultKeyHasher } from '@better-auth/api-key';
import { generateRandomString } from 'better-auth/crypto';
import { nanoid } from 'nanoid';
import type { apikey } from '../db/schema';

/**
 * How long an **Agent key** may live, in days, and the only three answers.
 * There is no "never": an Agent key always expires, and only its
 * Agent is permanent (ADR-0023).
 */
export const AGENT_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

export type AgentKeyExpiryDays = (typeof AGENT_KEY_EXPIRY_DAYS)[number];

/** What the create form starts on. */
export const DEFAULT_AGENT_KEY_EXPIRY_DAYS: AgentKeyExpiryDays = 90;

/**
 * Whether an Agent key whose `agent_expires_at` is `expiresAt` has expired at
 * `now` — at the instant itself, not a millisecond after. The one reading of
 * the expiry, for the endpoint's refusal and the console's listing alike;
 * `null` (a key `mintAgentKey` did not write) is not expired here, and the
 * endpoint refuses it as invalid on its own.
 */
export function agentKeyExpired(
  expiresAt: Date | null,
  now: Date | number = Date.now(),
): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() <= (typeof now === 'number' ? now : now.getTime())
  );
}

/**
 * The api-key plugin's own shape for a key, restated because an Agent key is
 * written straight to the table rather than through `auth.api.createApiKey`:
 * 64 letters, of which the first six are kept as `start` to tell keys apart on
 * screen. The plugin's session hook refuses a key shorter than its
 * `defaultKeyLength`, so matching it keeps an Agent key verifiable by the same
 * `verifyApiKey` a personal key is.
 */
const KEY_LENGTH = 64;
const START_LENGTH = 6;

/**
 * A new Agent key: the raw key, shown to the operator exactly once, and the
 * `apikey` row that stores only its hash.
 *
 * **Not `auth.api.createApiKey`, for two reasons.** It writes through
 * better-auth's adapter outside the caller's transaction, and an Agent is
 * created as user, member and first key in *one* transaction — a
 * failure after the key was minted would leave an Agent with a key and no
 * membership, or a key with no Agent. And it would put the expiry in the
 * plugin's `expiresAt`, which the plugin deletes on (see `agentExpiresAt` in
 * `auth.schema.ts`). The hash is the plugin's exported `defaultKeyHasher`, so
 * the row is one the plugin finds and verifies exactly as it finds its own.
 *
 * `permissions` and `metadata` are left null and are never read or shown
 * authority is the Agent's member row, never the key, and
 * `metadata` is rewritable by whoever holds the key.
 */
export async function mintAgentKey(
  agentUserId: string,
  expiresInDays: AgentKeyExpiryDays,
  now: Date = new Date(),
): Promise<{ key: string; row: typeof apikey.$inferInsert }> {
  const key = generateRandomString(KEY_LENGTH, 'a-z', 'A-Z');
  return {
    key,
    row: {
      id: nanoid(),
      name: null,
      start: key.substring(0, START_LENGTH),
      prefix: null,
      key: await defaultKeyHasher(key),
      configId: 'default',
      referenceId: agentUserId,
      enabled: true,
      // The plugin's per-key rate limit is off for every key; an Agent's
      // budget is the dispatcher's bucket, per Agent rather than per key.
      rateLimitEnabled: false,
      requestCount: 0,
      remaining: null,
      expiresAt: null,
      agentExpiresAt: new Date(now.getTime() + expiresInDays * 86_400_000),
      createdAt: now,
      updatedAt: now,
      permissions: null,
      metadata: null,
    },
  };
}
