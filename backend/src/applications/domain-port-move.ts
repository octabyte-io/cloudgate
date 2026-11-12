import { and, eq } from 'drizzle-orm';

import { domain } from '../db/schema';
import type { DrizzleTx } from '../environments/config-name';

/** An Application's port edit that moves its Domains: its old port and its new one. */
export interface PortChange {
  readonly from: number;
  readonly to: number;
}

/** One Domain the change moved, by its id and host. */
export interface MovedDomain {
  readonly domainId: string;
  readonly host: string;
}

/** One Domain of the Application the change left on another port. */
export interface LeftDomain {
  readonly domainId: string;
  readonly host: string;
  readonly port: number | null;
}

/**
 * What an Application's port change did to its Domains (ADR-0068, #1339),
 * on the update's answer and an Apply's change line: the Domains that were on
 * `from`, now on `to` and routed there, and every other Domain of the
 * Application, left on the port it names. Each list is by host.
 */
export interface DomainPortMove extends PortChange {
  readonly moved: readonly MovedDomain[];
  readonly left: readonly LeftDomain[];
}

/**
 * The port change an edit makes, or `null` when it moves no Domain: the port
 * is not in the edit, is edited to the value it has, or the Application is
 * in a Cloud account, whose routing follows its Service and never reads a
 * Domain's port.
 */
export function portChangeOf(
  current: { port: number; cloudAccountId: string | null },
  data: { port?: number },
): PortChange | null {
  if (current.cloudAccountId !== null) return null;
  if (data.port === undefined || data.port === current.port) return null;
  return { from: current.port, to: data.port };
}

/**
 * The Domains of one Application split by the change: those on the old port
 * are moved, every other one is left. A Domain with no port is left too;
 * nothing says it pointed at the old one.
 */
export function domainPortMoveOf(
  change: PortChange,
  domains: readonly LeftDomain[],
): DomainPortMove {
  const byHost = [...domains].sort((a, b) => a.host.localeCompare(b.host));
  return {
    from: change.from,
    to: change.to,
    moved: byHost
      .filter((row) => row.port === change.from)
      .map(({ domainId, host }) => ({ domainId, host })),
    left: byHost.filter((row) => row.port !== change.from),
  };
}

/**
 * Moves an Application's Domains on `change.from` to `change.to`, on `tx`,
 * the transaction that writes the Application's port, and answers what it
 * did. The routing is the caller's to rewrite, on the same transaction, so a
 * rewrite that fails leaves neither the port nor a Domain changed.
 */
export async function moveDomainsOnPort(
  tx: DrizzleTx,
  applicationId: string,
  change: PortChange,
): Promise<DomainPortMove> {
  const rows = await tx
    .select({ domainId: domain.domainId, host: domain.host, port: domain.port })
    .from(domain)
    .where(eq(domain.applicationId, applicationId));
  const move = domainPortMoveOf(change, rows);
  if (move.moved.length > 0) {
    await tx
      .update(domain)
      .set({ port: change.to })
      .where(
        and(
          eq(domain.applicationId, applicationId),
          eq(domain.port, change.from),
        ),
      );
  }
  return move;
}
