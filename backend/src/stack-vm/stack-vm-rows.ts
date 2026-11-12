import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import { compose, stackVmKey } from '../db/schema';
import type { Compose } from '../db/schema';
import { stackVmPublicKey } from './stack-vm-key';

/**
 * The rows a Stack VM's runs read by id, below the permission layer: what
 * reaches here was authorized by whoever named the stack. One copy each,
 * after the Cloud run, the Domain runs and the tunnel's connection had each
 * written its own "the stack is gone" and its own key read (#1357 review).
 */

/** The stack's row; throws while a run outlives it. */
export async function stackRowOf(
  db: DrizzleDB,
  composeId: string,
): Promise<Compose> {
  const [found] = await db
    .select()
    .from(compose)
    .where(eq(compose.composeId, composeId));
  if (!found) throw new Error('The stack is gone');
  return found;
}

/** The private half of the stack's own SSH key, as its create wrote it. */
export async function stackVmPrivateKeyOf(
  db: DrizzleDB,
  stack: Pick<Compose, 'composeId' | 'configName'>,
): Promise<string> {
  const [key] = await db
    .select({ privateKey: stackVmKey.privateKey })
    .from(stackVmKey)
    .where(eq(stackVmKey.composeId, stack.composeId));
  if (!key) throw new Error(`${stack.configName} has no Stack VM key`);
  return key.privateKey;
}

/**
 * The public half of the stack's own SSH key, which its Stack VM's first
 * boot authorizes and every definition of it writes.
 */
export async function stackVmPublicKeyOf(
  db: DrizzleDB,
  stack: Pick<Compose, 'composeId' | 'configName'>,
): Promise<string> {
  return stackVmPublicKey(await stackVmPrivateKeyOf(db, stack));
}
