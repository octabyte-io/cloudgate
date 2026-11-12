import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { utils as sshUtils } from 'ssh2';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { sshKey } from '../db/schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type {
  CreateSshKeyDto,
  SshKeyType,
  UpdateSshKeyDto,
} from './dto/ssh-key.dto';
import type { SshKey } from './ssh-key.schema';

/** An SSH key as exposed over the API — the private key never leaves the server. */
export type SanitizedSshKey = Omit<SshKey, 'privateKey'>;

/**
 * The one response that may carry the private half: a freshly created key.
 * `privateKey` is present only when Cloudgate generated the keypair — see the
 * comment at the return site in `create`.
 */
export type CreatedSshKey = SanitizedSshKey & { privateKey?: string };

function stripPrivateKey(row: SshKey): SanitizedSshKey {
  const { privateKey, ...rest } = row;
  void privateKey;
  return rest;
}

/** The marker every generated key's comment opens with — see {@link generatedKeyComment}. */
const GENERATED_KEY_MARKER = 'cloudgate';

/**
 * The trailing comment on a generated key's public half, which is what an
 * operator reads in a host's `authorized_keys`.
 *
 * Every generated key used to carry the bare marker, so a host that had held
 * more than one of them had several indistinguishable `… cloudgate` lines and
 * the only way to find the one belonging to a key since deleted in Cloudgate —
 * whose line still grants access — was to compare base64 blobs.
 *
 * **`cloudgate:<name>`, not `cloudgate-<organization>-<name>`.** The marker
 * stays first and stays spelled `cloudgate`, so a grep for it still finds every
 * line Cloudgate put on a host, `LocalServerSetupService.setupSshKey`'s
 * `cloudgate-local-access` included. The separator is `:` rather than `-`
 * because key names contain hyphens themselves, and `cloudgate-ui-ed25519`
 * cannot be split back into marker and name while `cloudgate:ui-ed25519` can.
 * The organization is left out because the only handle at this point is
 * `activeOrganizationId`, an opaque nanoid that tells a person reading a host
 * nothing; its display name would cost a join *and* go stale, since nothing
 * rewrites a comment already pasted into a host.
 *
 * **The sanitisation is not cosmetic.** `ssh2` writes this string verbatim as
 * the remainder of the public-key line, so a name containing a newline would
 * make the line an operator pastes into `authorized_keys` grant a *second*
 * entry of the caller's choosing. Nothing upstream prevents one —
 * `createSshKeySchema`'s `name` is `z.string().min(1)` and the column is plain
 * `text` — so the constraint belongs here. The allowlist is the charset
 * `APP_NAME_REGEX` already blesses as safe in a shell word; a disallowed run
 * collapses to a single `_` rather than being deleted, so `a b` and `ab` stay
 * different comments. Deliberately no length cap: truncating manufactures
 * collisions between names that differ only past the cap, and an over-long
 * comment is merely ugly.
 *
 * A name with nothing left after that falls back to the bare marker, which is
 * the old behaviour and is correct — there is nothing to say about it.
 */
export function generatedKeyComment(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  return sanitized
    ? `${GENERATED_KEY_MARKER}:${sanitized}`
    : GENERATED_KEY_MARKER;
}

@Injectable()
export class SshKeysService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Create a key, scoped to the session's active organization. A missing
   * keypair is generated (RSA by default).
   */
  async create(
    ctx: PermissionCtx,
    data: CreateSshKeyDto,
  ): Promise<CreatedSshKey> {
    const { type, ...fields } = data;
    const imported = Boolean(fields.publicKey && fields.privateKey);
    const keyPair =
      fields.publicKey && fields.privateKey
        ? { publicKey: fields.publicKey, privateKey: fields.privateKey }
        : this.generateKeyPair(fields.name, type);
    const [created] = await this.db
      .insert(sshKey)
      .values({
        ...fields,
        ...keyPair,
        organizationId: ctx.session.activeOrganizationId,
      })
      .returning();
    // The one deliberate exception to "the private key never leaves the
    // server". On the *generate* path this response is the only place
    // the private half is ever visible — `list`, `findOne`, `update` and
    // `remove` are all sanitized — so a caller that does not capture it here
    // cannot recover it. On the *import* path the caller supplied the key and
    // already has it, so echoing it back only widens where the bytes travel;
    // that path is sanitized like every other read.
    return imported ? stripPrivateKey(created) : created;
  }

  /**
   * Generate a keypair: RSA 4096 by default, else ed25519. The public half ends
   * in {@link generatedKeyComment} of the key's name, so the line an operator
   * installs on a host says which key it is. Only this path sets a comment — an
   * imported keypair keeps whatever the operator's own line already ends in.
   */
  private generateKeyPair(name: string, type: SshKeyType = 'rsa') {
    const comment = generatedKeyComment(name);
    const keys =
      type === 'rsa'
        ? sshUtils.generateKeyPairSync('rsa', { bits: 4096, comment })
        : sshUtils.generateKeyPairSync('ed25519', { comment });
    return { publicKey: keys.public, privateKey: keys.private };
  }

  /**
   * The organization's keys, newest first, private keys stripped.
   */
  async list(ctx: PermissionCtx): Promise<SanitizedSshKey[]> {
    const rows = await this.db
      .select()
      .from(sshKey)
      .where(eq(sshKey.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(sshKey.createdAt));
    return rows.map(stripPrivateKey);
  }

  /**
   * One key — a key is only visible inside its organization, and the private
   * key is stripped on the way out.
   */
  async findOne(
    ctx: PermissionCtx,
    sshKeyId: string,
  ): Promise<SanitizedSshKey> {
    return stripPrivateKey(await this.findOneWithPrivateKey(ctx, sshKeyId));
  }

  /**
   * The full row including the decrypted private key, for internal use
   * (SSH channels, source clones). Never returned from a controller.
   * Mirrors RegistriesService.findOneWithCredentials.
   */
  async findOneWithPrivateKey(
    ctx: PermissionCtx,
    sshKeyId: string,
  ): Promise<SshKey> {
    const [found] = await this.db
      .select()
      .from(sshKey)
      .where(
        and(
          eq(sshKey.sshKeyId, sshKeyId),
          eq(sshKey.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('SSH key not found');
    return found;
  }

  /**
   * Update a key's name, description or lastUsedAt, org-scoped through
   * findOneWithPrivateKey. The keypair is immutable, so a rename has no reason
   * to hand it back.
   */
  async update(
    ctx: PermissionCtx,
    sshKeyId: string,
    data: UpdateSshKeyDto,
  ): Promise<SanitizedSshKey> {
    const current = await this.findOneWithPrivateKey(ctx, sshKeyId);
    const [updated] = await this.db
      .update(sshKey)
      .set(data)
      .where(eq(sshKey.sshKeyId, current.sshKeyId))
      .returning();
    return stripPrivateKey(updated);
  }

  /**
   * Delete a key, org-scoped through findOneWithPrivateKey. The deleted row is
   * echoed back for the caller to confirm what went, private key stripped —
   * nothing needs it after a delete.
   */
  async remove(ctx: PermissionCtx, sshKeyId: string): Promise<SanitizedSshKey> {
    const current = await this.findOneWithPrivateKey(ctx, sshKeyId);
    const [removed] = await this.db
      .delete(sshKey)
      .where(eq(sshKey.sshKeyId, current.sshKeyId))
      .returning();
    return stripPrivateKey(removed);
  }
}
