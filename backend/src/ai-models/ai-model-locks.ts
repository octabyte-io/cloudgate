import { isDeepStrictEqual } from 'node:util';
import { ConflictException } from '@nestjs/common';
import { parse } from 'dotenv';
import { eq } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import { GPU_VISIBILITY_ENV_NAMES } from '../settings/gpu-visibility';
import { aiModelFacet } from './ai-model.schema';

type Db = DrizzleDB | DrizzleTx;

/**
 * The Application settings the gateway depends on, which the platform writes
 * for an AI model at create and the API refuses to change after:
 * the source and image it runs, how it is started, the port and
 * health check the gateway and the deploy read, and the networks and
 * published ports that keep it reachable through the gateway alone.
 *
 * `dockerImage` is the repository *and* tag; the tag is edited through the
 * facet (`aiModel.imageTag`), which rewrites this column itself.
 */
export const AI_MODEL_LOCKED_FIELDS = [
  'sourceType',
  'dockerImage',
  'command',
  'args',
  'port',
  'healthCheckSwarm',
  'networkSwarm',
  'endpointSpecSwarm',
] as const;

type LockedField = (typeof AI_MODEL_LOCKED_FIELDS)[number];

/**
 * The env names the platform owns on an AI model: the runtime's own
 * (`OLLAMA_HOST`, the weights path `OLLAMA_MODELS`, `HF_HOME` or
 * `LLAMA_CACHE`, the Hugging Face token) and the GPU visibility pair the platform
 * owns on every container. The rest of the env stays the operator's.
 */
export const AI_MODEL_LOCKED_ENV_NAMES: readonly string[] = [
  'OLLAMA_HOST',
  'OLLAMA_MODELS',
  'HF_HOME',
  'LLAMA_CACHE',
  'HF_TOKEN',
  ...GPU_VISIBILITY_ENV_NAMES,
];

/**
 * Whether `applicationId` is an AI model, and its locked settings as stored
 * when it is; `null` on a plain Application.
 */
async function readLockedSettings(
  db: Db,
  applicationId: string,
): Promise<Pick<typeof application.$inferSelect, LockedField> | null> {
  const [row] = await db
    .select({
      sourceType: application.sourceType,
      dockerImage: application.dockerImage,
      command: application.command,
      args: application.args,
      port: application.port,
      healthCheckSwarm: application.healthCheckSwarm,
      networkSwarm: application.networkSwarm,
      endpointSpecSwarm: application.endpointSpecSwarm,
    })
    .from(application)
    .innerJoin(
      aiModelFacet,
      eq(aiModelFacet.applicationId, application.applicationId),
    )
    .where(eq(application.applicationId, applicationId))
    .limit(1);
  return row ?? null;
}

/** Whether `applicationId` carries the AI model facet. */
export async function isAiModel(
  db: Db,
  applicationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ applicationId: aiModelFacet.applicationId })
    .from(aiModelFacet)
    .where(eq(aiModelFacet.applicationId, applicationId))
    .limit(1);
  return row !== undefined;
}

/**
 * Refuses an Application settings write that would change what the gateway
 * depends on, when `applicationId` is an AI model; a plain
 * Application passes untouched.
 *
 * **In the service, not the DTO**, because whether a field is locked is a
 * fact about the row, and because every writer of these columns — `PATCH
 * /applications/:id`, `PATCH /applications/:id/environment`, the drop upload,
 * a Project config Apply and any MCP tool that ever updates an Application —
 * funnels through `ApplicationsService`, so one check here covers them all.
 * No MCP tool updates an Application today (`FROZEN_TOOLS`).
 *
 * **A change, not a mention**: a field sent with the value it already holds
 * is admitted, so a client that echoes back the resource it read (as the
 * console's forms do) is not refused for a field it did not touch. Each
 * refusal names the field, and env names are refused whenever the new env
 * assigns one: the platform's value wins at deploy, so an assignment could
 * only ever mislead.
 */
export async function assertAiModelLocksHeld(
  db: Db,
  applicationId: string,
  edit: Partial<Record<LockedField | 'env', unknown>>,
): Promise<void> {
  const stored = await readLockedSettings(db, applicationId);
  if (!stored) return;
  for (const field of AI_MODEL_LOCKED_FIELDS) {
    if (edit[field] === undefined) continue;
    if (isDeepStrictEqual(edit[field] ?? null, stored[field] ?? null)) continue;
    throw new ConflictException(
      field === 'dockerImage'
        ? 'dockerImage is set by the platform on an AI model; change its image tag through aiModel.imageTag'
        : `${field} is set by the platform on an AI model`,
    );
  }
  const owned = lockedEnvNames(edit.env);
  if (owned.length > 0) {
    throw new ConflictException(
      `${owned.join(', ')} ${owned.length === 1 ? 'is' : 'are'} set by the platform on an AI model; remove ${owned.length === 1 ? 'it' : 'them'} from the env`,
    );
  }
}

/**
 * The platform-owned names an env body assigns, parsed with `dotenv`'s own
 * `parse` — what the deploy reads the env through
 * (`prepareEnvironmentVariables`), so what is refused here is exactly what
 * the deploy would call an assignment (see `reservedEnvKeys`).
 */
function lockedEnvNames(env: unknown): string[] {
  if (typeof env !== 'string' || env === '') return [];
  return Object.keys(parse(env)).filter((key) =>
    AI_MODEL_LOCKED_ENV_NAMES.includes(key),
  );
}

/** Refuses a published port on an AI model. */
export async function assertNotAiModelForPort(
  db: Db,
  applicationId: string,
): Promise<void> {
  if (await isAiModel(db, applicationId)) {
    throw new ConflictException(
      'An AI model publishes no port; it is reached through its gateway endpoint',
    );
  }
}

/** Refuses a Domain on an AI model. */
export async function assertNotAiModelForDomain(
  db: Db,
  applicationId: string,
): Promise<void> {
  if (await isAiModel(db, applicationId)) {
    throw new ConflictException(
      'An AI model takes no Domain; it is reached through its gateway endpoint',
    );
  }
}
