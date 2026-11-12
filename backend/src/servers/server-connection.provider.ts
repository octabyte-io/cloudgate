import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { boughtServer } from '../bought-servers/bought-server.schema';
import { isRetiredStage } from '../bought-servers/retired-servers';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { server, sshKey } from '../db/schema';
import { trustOnFirstUse } from '../remote/host-key';
import type { HostKeyCheck } from '../remote/host-key';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../remote/server-key.provider';
import { ServerAddressGuard } from './server-address-guard';

/** A Server whose `ssh_key_id` is null, or names a key with no private half. */
export const NO_KEY_MESSAGE = 'Server has no SSH key assigned';

/**
 * A Server whose `ssh_key_id` names a key in a **different** organization —
 * a broken row, not a configuration gap. See {@link unusableKeyMessage}.
 */
export const FOREIGN_KEY_MESSAGE =
  "Server's SSH key belongs to another organization";

/**
 * A Server whose **Bought Server** is Deleting or Deleted: its machine may
 * be gone and its address handed to someone else's machine, so nothing
 * connects to it (spec #1387, story 76).
 */
export const RETIRED_SERVER_MESSAGE =
  'This Server is being deleted or was deleted, so Cloudgate no longer connects to it';

/**
 * Which refusal a Server with no usable private key gets.
 *
 * `assigned` is `server.ssh_key_id` as the row carries it; `resolved` is the
 * `ssh_key_id` the **organization-scoped** join came back with. Three states,
 * two messages:
 *
 * - nothing assigned → {@link NO_KEY_MESSAGE}, the setup gap this provider has
 *   always named (a key deleted out from under a Server lands here too:
 *   `server.sshKeyId` is `on delete set null`).
 * - assigned, and the join resolved it, but the private half is empty →
 *   {@link NO_KEY_MESSAGE} as well. `sshKey.privateKey` is `.notNull()` with a
 *   `''` default, so the column can hold nothing; that case answered this
 *   sentence before and still does, because it is a gap in the key and
 *   not a tenancy fault. It is *not* folded into the branch below, which is
 *   the whole reason `resolved` is selected separately rather than inferred
 *   from a falsy `privateKey`.
 * - assigned, and the join resolved **nothing** → the key exists (the foreign
 *   key guarantees it) and sits in another organization:
 *   {@link FOREIGN_KEY_MESSAGE}.
 *
 * **The two are deliberately distinguishable, and that is not an ADR-0008
 * oracle.** Saying *"no SSH key assigned"* about a row whose `ssh_key_id` is
 * plainly populated sends an operator looking for a bug in the column instead
 * of at the row, and the remedies differ: one Server needs a key, the other
 * needs a security-relevant row corrected. ADR-0008's rule is that a refusal
 * must disclose nothing about ids elsewhere on the instance — this one names
 * no id, and it is only reachable for a Server already inside the caller's own
 * organization (every HTTP and socket path org-scopes the Server before it
 * gets here), about an id that organization wrote itself. After
 * `ServersService`'s create/update check, no new row of this shape can be
 * made at all; what is left is rows written before the fix, or straight into
 * the database.
 */
export function unusableKeyMessage(
  assigned: string | null,
  resolved: string | null,
): string {
  return assigned !== null && resolved === null
    ? FOREIGN_KEY_MESSAGE
    : NO_KEY_MESSAGE;
}

/**
 * The servers-module implementation of the SERVER_KEY_PROVIDER contract from
 * phase 10: resolve a serverId to its SSH connection details (the private key
 * is decrypted by the encryptedText column on read). Resolution is by id, not
 * permission ctx — callers (RemoteExecService, RemoteDockerFactory) sit below
 * the permission layer.
 */
@Injectable()
export class ServerConnectionProvider implements ServerKeyProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly addressGuard: ServerAddressGuard,
  ) {}

  async getConnection(serverId: string): Promise<ServerConnection> {
    const [found] = await this.db
      .select({
        name: server.name,
        ipAddress: server.ipAddress,
        port: server.port,
        username: server.username,
        // What the Server row claims, beside what the join could actually
        // resolve for it — `unusableKeyMessage` needs both to tell a Server
        // with no key from a Server pointing at somebody else's.
        assignedKeyId: server.sshKeyId,
        resolvedKeyId: sshKey.sshKeyId,
        privateKey: sshKey.privateKey,
        hostKeyFingerprint: server.hostKeyFingerprint,
        boughtStage: boughtServer.stage,
      })
      .from(server)
      // **The organization predicate belongs here, in the join, and not only
      // in the writers that set `sshKeyId`.** Both writers now resolve
      // the id organization-scoped, and this is still not redundant: this is
      // the last gate before a private key is decrypted and used to
      // authenticate, it is reached from below the permission layer by
      // `RemoteExecService` and `RemoteDockerFactory` with nothing but an id,
      // and the defect reported was exactly a gate that depended on
      // every writer upstream having been careful. `server.sshKeyId → ssh_key`
      // names no organization column, so the foreign key alone was satisfied
      // by any key on the instance, whoever owned it — an owner of one
      // organization could point their own Server at another organization's
      // key and get a signing oracle for a credential they were never granted.
      //
      // As a predicate rather than a comparison after the fact: the private
      // key of a foreign row is then never selected at all, so `encryptedText`
      // never decrypts it and the plaintext never enters this process.
      //
      // Still a `leftJoin`. An `innerJoin` would answer `'Server not found'`
      // for a Server that plainly exists in the caller's organization, and
      // would swallow the no-key-assigned branch below into the same lie.
      .leftJoin(
        sshKey,
        and(
          eq(server.sshKeyId, sshKey.sshKeyId),
          eq(sshKey.organizationId, server.organizationId),
        ),
      )
      // The last gate before any connect, so the one place a Deleting or
      // Deleted Bought Server is refused: before its key is used, and
      // before its address is even resolved.
      .leftJoin(boughtServer, eq(boughtServer.serverId, server.serverId))
      .where(eq(server.serverId, serverId))
      .limit(1);

    if (!found) throw new NotFoundException('Server not found');
    if (isRetiredStage(found.boughtStage)) {
      throw new ConflictException({
        code: 'SERVER_RETIRED',
        message: RETIRED_SERVER_MESSAGE,
      });
    }
    if (!found.privateKey) {
      throw new NotFoundException(
        unusableKeyMessage(found.assignedKeyId, found.resolvedKeyId),
      );
    }

    // Every SSH connect gets its host here, so this is where the Hosted
    // instance checks the address again: a name that resolved
    // publicly when it was saved may not now. The checked address is the one
    // handed back to dial; self-hosted it is the stored address unchanged.
    const host = await this.addressGuard.addressToDial(found.ipAddress);

    return {
      host,
      port: found.port,
      username: found.username,
      privateKey: found.privateKey,
      hostKey: this.hostKeyCheck(
        serverId,
        found.name,
        found.hostKeyFingerprint,
      ),
    };
  }

  /**
   * Trust on first use against this Server's `host_key_fingerprint`
   * (ADR-0074). The first-use write is conditional on the column still being
   * empty, so of two first connects racing, the second's write changes
   * nothing and it is answered the fingerprint the first recorded: the same
   * key is accepted, a different one refused.
   */
  private hostKeyCheck(
    serverId: string,
    serverName: string,
    recorded: string | null,
  ): HostKeyCheck {
    return trustOnFirstUse(serverName, recorded, {
      recordFirst: async (fingerprint) => {
        await this.db
          .update(server)
          .set({ hostKeyFingerprint: fingerprint })
          .where(
            and(
              eq(server.serverId, serverId),
              isNull(server.hostKeyFingerprint),
            ),
          );
        const [row] = await this.db
          .select({ hostKeyFingerprint: server.hostKeyFingerprint })
          .from(server)
          .where(eq(server.serverId, serverId))
          .limit(1);
        return row?.hostKeyFingerprint ?? null;
      },
    });
  }
}
