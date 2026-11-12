import { api } from "../client";

/**
 * `ssh-keys.controller.ts` — the key that reaches a Server.
 *
 * F09 declared only the list, for one picker. **F13 owns these screens** and
 * fills the module in: create, rename and delete.
 *
 * Three facts about this controller shape the screens above it, and each one is
 * a decision the UI cannot avoid making:
 *
 * 1. **The private key is on exactly one response, and it is never repeated.**
 *    `privateKey` is `encryptedText` — encrypted at rest, decrypted on the way
 *    out — so every route that returned the whole row returned the plaintext
 *    key. `list` and `findOne` were sanitized in
 * `update` and
 *    `remove` and the *import* path of `create` in
 * What survives
 *    is deliberate: when Cloudgate **generates** the pair, `POST /ssh-keys` is
 *    the only place the private half is ever visible, and a caller that does not
 *    capture it there cannot get it back. Hence `CreatedSshKey` below, the one
 *    type in this module that declares `privateKey` at all — and it is optional,
 *    because an imported key does not come back.
 * 2. **The keypair is immutable.** `updateSshKeySchema` takes `name`,
 *    `description` and `lastUsedAt` and nothing else, so there is no rotation —
 *    replacing a key means adding a new one and re-pointing the Servers.
 * 3. **A key is generated only when *neither* half is supplied.** `create` reads
 *    `fields.publicKey && fields.privateKey`, so pasting one half silently
 *    generates a **fresh pair** and throws the paste away. The form therefore
 *    asks for both or for neither, and never for one.
 *
 * And one that decides what deleting says: `server.sshKeyId` is
 * `onDelete: 'set null'`, so removing a key does not refuse while Servers are
 * using it — it leaves them with **no key at all**, which is a Server nothing
 * can reach until another one is chosen.
 */

/** `rsa` is 4096-bit; `ed25519` is the shorter modern one. Both are generated
 *  with the comment `cloudgate:<key name>`, so a host's `authorized_keys` says
 *  which key each line belongs to. A pasted keypair keeps its own comment. */
export type SshKeyType = "rsa" | "ed25519";

/**
 * The row, minus its private half.
 *
 * `publicKey` **is** declared, because a public key is public by definition and
 * it is the one thing an operator genuinely needs off this screen: installing it
 * in a host's `authorized_keys` is what makes the key work, and that is a
 * recurring job, not a one-time reveal.
 */
export interface SshKeySummary {
  sshKeyId: string;
  name: string;
  description: string | null;
  publicKey: string;
  createdAt: string;
  /** Written by nothing in this backend today, so it reads "Never" for every key. */
  lastUsedAt: string | null;
  organizationId: string;
}

/**
 * What `POST /ssh-keys` answers.
 *
 * `privateKey` is present **only** when the server generated the pair — a
 * request that supplied both halves gets a plain {@link SshKeySummary} back,
 * because the caller already holds the key. It is optional for that reason, and
 * a screen that wants to offer the generated key for download has to read it
 * from this one response: no later request returns it.
 */
export type CreatedSshKey = SshKeySummary & { privateKey?: string };

export interface CreateSshKeyInput {
  name: string;
  description?: string;
  /**
   * Both halves, or neither. See fact 3 above — one half alone is discarded and
   * a fresh pair is generated in its place, silently.
   */
  publicKey?: string;
  privateKey?: string;
  /** Only consulted when generating. Defaults to `rsa` server-side. */
  type?: SshKeyType;
}

/** Name and description. The keypair cannot be changed. */
export interface UpdateSshKeyInput {
  name?: string;
  description?: string | null;
}

export const sshKeysApi = {
  list: () => api.get<SshKeySummary[]>("/ssh-keys"),

  /** Carries `privateKey` back only on the generate path. See {@link CreatedSshKey}. */
  create: (input: CreateSshKeyInput) =>
    api.post<CreatedSshKey>("/ssh-keys", input),

  update: (sshKeyId: string, input: UpdateSshKeyInput) =>
    api.patch<SshKeySummary>(`/ssh-keys/${sshKeyId}`, input),

  /** Leaves every Server that used it with `sshKeyId: null`. Name them first. */
  remove: (sshKeyId: string) =>
    api.delete<SshKeySummary>(`/ssh-keys/${sshKeyId}`),
};
