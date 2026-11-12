import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DrizzleDB } from '../../db/drizzle.module';
import type { DrizzleTx } from '../../environments/config-name';
import type {
  PendingSetupInput,
  PendingSetupPart,
  SetupRecordInput,
  TemplateDomain,
} from '../../project-config/planner/plan.types';
import { pendingSetup } from './pending-setup.schema';
import type { PendingSetupBody } from './pending-setup.schema';
import { setupRecord } from './setup-record.schema';

/**
 * The Pending setup's reads and writes outside the setup service: what a
 * Plan reads beside the saved Services, what an Apply takes out, and what a
 * dismissed Plan drops. Plain functions over the database, as the database
 * switch's are (`database-switches.ts`), so the project-config module needs
 * no templates module to reach them.
 */

/** The Environment's Pending setups as a plan reads them: no values. */
export async function pendingSetupsOf(
  db: DrizzleDB | DrizzleTx,
  environmentId: string,
): Promise<PendingSetupInput[]> {
  const rows = await db
    .select({
      pendingSetupId: pendingSetup.pendingSetupId,
      templateId: pendingSetup.templateId,
      templateName: pendingSetup.templateName,
      setupName: pendingSetup.setupName,
      parts: pendingSetup.parts,
    })
    .from(pendingSetup)
    .where(eq(pendingSetup.environmentId, environmentId))
    .orderBy(pendingSetup.createdAt);
  return rows;
}

/**
 * The Project's Setup records as a plan reads them: only to hold a setup's
 * parts back where it was not set up (#1377), never to update anything.
 */
export async function setupRecordsOf(
  db: DrizzleDB | DrizzleTx,
  projectId: string,
): Promise<SetupRecordInput[]> {
  return db
    .select({
      setupRecordId: setupRecord.setupRecordId,
      templateId: setupRecord.templateId,
      setupName: setupRecord.setupName,
      configNames: setupRecord.configNames,
    })
    .from(setupRecord)
    .where(eq(setupRecord.projectId, projectId))
    .orderBy(setupRecord.createdAt);
}

/**
 * The values each part a plan creates takes from its Pending setup, by
 * Config name; a part whose setup is gone, or no longer holds it, is absent.
 */
export async function pendingValuesOf(
  db: DrizzleDB,
  environmentId: string,
  parts: readonly { pendingSetupId: string; configName: string }[],
): Promise<Map<string, Readonly<Record<string, string>>>> {
  const found = new Map<string, Readonly<Record<string, string>>>();
  if (parts.length === 0) return found;
  const rows = await db
    .select({
      pendingSetupId: pendingSetup.pendingSetupId,
      parts: pendingSetup.parts,
      body: pendingSetup.body,
    })
    .from(pendingSetup)
    .where(
      and(
        eq(pendingSetup.environmentId, environmentId),
        inArray(
          pendingSetup.pendingSetupId,
          parts.map((part) => part.pendingSetupId),
        ),
      ),
    );
  for (const part of parts) {
    const row = rows.find((one) => one.pendingSetupId === part.pendingSetupId);
    if (!row?.parts.some((one) => one.configName === part.configName)) continue;
    found.set(part.configName, row.body.values[part.configName] ?? {});
  }
  return found;
}

/** What a part's create writes beside its values: its stack's file and its config files. */
export interface PendingWrites {
  /** A compose part's compose file; null for an own-kind part. */
  readonly composeFile: string | null;
  readonly files: readonly {
    readonly path: string;
    readonly mount: string | null;
    readonly content: string;
  }[];
}

/**
 * The compose file and config files each part a plan creates takes from its
 * Pending setup, by Config name (#1373); a part whose setup is gone, or no
 * longer holds it, is absent, as in {@link pendingValuesOf}.
 */
export async function pendingWritesOf(
  db: DrizzleDB,
  environmentId: string,
  parts: readonly { pendingSetupId: string; configName: string }[],
): Promise<Map<string, PendingWrites>> {
  const found = new Map<string, PendingWrites>();
  if (parts.length === 0) return found;
  const rows = await db
    .select({
      pendingSetupId: pendingSetup.pendingSetupId,
      parts: pendingSetup.parts,
      body: pendingSetup.body,
    })
    .from(pendingSetup)
    .where(
      and(
        eq(pendingSetup.environmentId, environmentId),
        inArray(
          pendingSetup.pendingSetupId,
          parts.map((part) => part.pendingSetupId),
        ),
      ),
    );
  for (const part of parts) {
    const row = rows.find((one) => one.pendingSetupId === part.pendingSetupId);
    const held = row?.parts.find((one) => one.configName === part.configName);
    if (!row || !held) continue;
    found.set(part.configName, {
      composeFile: held.kind === 'compose' ? row.body.composeFile : null,
      files: row.body.files
        .filter((file) => file.configName === part.configName)
        .map(({ path, mount, content }) => ({ path, mount, content })),
    });
  }
  return found;
}

/**
 * Takes one created part out of its Pending setup: its Config name from
 * `parts`, its values and files from the body. The row goes once no part is
 * left (ADR-0065 "When it is dropped").
 */
export async function takePart(
  db: DrizzleDB,
  pendingSetupId: string,
  configName: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(pendingSetup)
      .where(eq(pendingSetup.pendingSetupId, pendingSetupId))
      .for('update');
    if (!row) return;
    const parts = row.parts.filter((part) => part.configName !== configName);
    if (parts.length === 0) {
      await tx
        .delete(pendingSetup)
        .where(eq(pendingSetup.pendingSetupId, pendingSetupId));
      return;
    }
    const taken = row.parts.find((part) => part.configName === configName);
    if (!taken) return;
    await tx
      .update(pendingSetup)
      .set({ parts, body: bodyWithoutPart(row.body, taken) })
      .where(eq(pendingSetup.pendingSetupId, pendingSetupId));
  });
}

/**
 * A Pending setup's body once `taken` is created: its values, its config
 * files, a compose part's compose file, and the hosts it carries, a compose
 * part's Domains' and a web's generated one ("Each Apply removes what it
 * creates"). The hosts go by value, since `hosts` is keyed by the
 * template's own names and a part by its Config name.
 */
export function bodyWithoutPart(
  body: PendingSetupBody,
  taken: PendingSetupPart,
): PendingSetupBody {
  const values = { ...body.values };
  delete values[taken.configName];
  const itsHosts = new Set([
    ...(taken.domains ?? []).map((domain) => domain.host),
    ...(taken.host === undefined ? [] : [taken.host]),
  ]);
  return {
    values,
    hosts: Object.fromEntries(
      Object.entries(body.hosts).filter(([, host]) => !itsHosts.has(host)),
    ),
    // A setup has one compose part: once made, its file is the stack's.
    composeFile: taken.kind === 'compose' ? null : body.composeFile,
    files: body.files.filter((file) => file.configName !== taken.configName),
  };
}

/**
 * Takes a compose part whose stack an Apply made in a Cloud Environment
 * (#1379, ADR-0065 as amended): its values, compose file and files are the
 * stack's now and leave the body, but while it has Domains the part stays,
 * naming the stack, for the Cloud run to add them once its Stack VM is made
 * ({@link stackDomainsWaiting}, then {@link takePart}). With none, it is
 * taken whole.
 */
export async function takeStackPart(
  db: DrizzleDB,
  pendingSetupId: string,
  configName: string,
  composeId: string,
): Promise<void> {
  const whole = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(pendingSetup)
      .where(eq(pendingSetup.pendingSetupId, pendingSetupId))
      .for('update');
    const taken = row?.parts.find((part) => part.configName === configName);
    if (!row || !taken) return false;
    if (!taken.domains?.length) return true;
    const values = { ...row.body.values };
    delete values[configName];
    await tx
      .update(pendingSetup)
      .set({
        parts: row.parts.map((part) =>
          part === taken
            ? {
                configName,
                kind: part.kind,
                made: {},
                domains: part.domains,
                stackId: composeId,
              }
            : part,
        ),
        body: {
          ...row.body,
          values,
          composeFile: null,
          files: row.body.files.filter(
            (file) => file.configName !== configName,
          ),
        },
      })
      .where(eq(pendingSetup.pendingSetupId, pendingSetupId));
    return false;
  });
  if (whole) await takePart(db, pendingSetupId, configName);
}

/**
 * The Domains a Pending setup holds for a stack an Apply made, waiting for
 * its Stack VM (#1379): the setup's id and the Domains, or `null`.
 */
export async function stackDomainsWaiting(
  db: DrizzleDB,
  composeId: string,
): Promise<{
  readonly pendingSetupId: string;
  readonly configName: string;
  readonly domains: readonly TemplateDomain[];
} | null> {
  const rows = await db
    .select({
      pendingSetupId: pendingSetup.pendingSetupId,
      parts: pendingSetup.parts,
    })
    .from(pendingSetup)
    .where(
      sql`jsonb_contains(${pendingSetup.parts}, ${JSON.stringify([{ stackId: composeId }])}::jsonb)`,
    );
  for (const row of rows) {
    const part = row.parts.find((one) => one.stackId === composeId);
    if (part) {
      return {
        pendingSetupId: row.pendingSetupId,
        configName: part.configName,
        domains: part.domains ?? [],
      };
    }
  }
  return null;
}

/**
 * Drops the Pending setups whose parts a dismissed plan was to create, and
 * answers their Setup records' ids. Only a Cloudgate-kept config's dismiss
 * calls it: that config's text changes only at Apply, so the setup left
 * nothing else behind (ADR-0065).
 */
export async function dropPendingSetups(
  db: DrizzleDB | DrizzleTx,
  environmentId: string,
  pendingSetupIds: readonly string[],
): Promise<string[]> {
  if (pendingSetupIds.length === 0) return [];
  const dropped = await db
    .delete(pendingSetup)
    .where(
      and(
        eq(pendingSetup.environmentId, environmentId),
        inArray(pendingSetup.pendingSetupId, [...pendingSetupIds]),
      ),
    )
    .returning({ setupRecordId: pendingSetup.setupRecordId });
  return dropped.flatMap((row) =>
    row.setupRecordId === null ? [] : [row.setupRecordId],
  );
}

/**
 * Drops the Setup records a dropped setup left that record nothing: no
 * Pending setup still points at one, and none of its Config names is in the
 * Project's stored text, which a Cloudgate-kept config gains only at Apply.
 * A record whose part some Apply made stays: it is a fact about that part.
 */
export async function dropUnusedSetupRecords(
  db: DrizzleDB | DrizzleTx,
  setupRecordIds: readonly string[],
  storedNames: ReadonlySet<string>,
): Promise<void> {
  if (setupRecordIds.length === 0) return;
  const records = await db
    .select({
      setupRecordId: setupRecord.setupRecordId,
      configNames: setupRecord.configNames,
    })
    .from(setupRecord)
    .where(inArray(setupRecord.setupRecordId, [...setupRecordIds]));
  const stillPending = new Set(
    (
      await db
        .select({ setupRecordId: pendingSetup.setupRecordId })
        .from(pendingSetup)
        .where(inArray(pendingSetup.setupRecordId, [...setupRecordIds]))
    ).map((row) => row.setupRecordId),
  );
  const unused = records
    .filter(
      (record) =>
        !stillPending.has(record.setupRecordId) &&
        !record.configNames.some((name) => storedNames.has(name)),
    )
    .map((record) => record.setupRecordId);
  if (unused.length === 0) return;
  await db
    .delete(setupRecord)
    .where(inArray(setupRecord.setupRecordId, unused));
}

/** Every Config name a Pending setup in these Environments will create. */
export async function pendingConfigNames(
  db: DrizzleDB | DrizzleTx,
  environmentIds: readonly string[],
): Promise<Set<string>> {
  if (environmentIds.length === 0) return new Set();
  const rows = await db
    .select({ parts: pendingSetup.parts })
    .from(pendingSetup)
    .where(inArray(pendingSetup.environmentId, [...environmentIds]));
  return new Set(
    rows.flatMap((row) => row.parts.map((part) => part.configName)),
  );
}
