import { randomBytes } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { count, eq, isNull, sql } from 'drizzle-orm';
import { application } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import { execOnServer } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { aiModelFacet } from './ai-model.schema';
import type { InferenceRuntime } from './ai-model.schema';
import { joinAiNetworkProgram } from './ai-network';
import type { CreateAiModel, UpdateAiModel } from './dto/ai-model.dto';
import {
  HF_TOKEN_RUNTIMES_PHRASE,
  INFERENCE_RUNTIMES,
  isOffPin,
  runtimeImage,
} from './inference-runtime';

type Db = DrizzleDB | DrizzleTx;

/**
 * An AI model's facet as every read shows it: never the upstream
 * secret, not even whether there is one. `imageTag` is the tag it runs, the
 * pin when none was chosen, `pin` is the runtime's tested tag (so the console
 * can show it beside an off-pin one), and `offPin` says when the two
 * differ. The Hugging Face token is write-only, so a read says only whether
 * one is set (`hasHfToken`).
 */
export interface AiModelRead {
  runtime: InferenceRuntime;
  model: string;
  imageTag: string;
  pin: string;
  offPin: boolean;
  hasHfToken: boolean;
}

/** The facet columns a read selects: never a secret, the token as a flag. */
const readColumns = {
  runtime: aiModelFacet.runtime,
  model: aiModelFacet.model,
  imageTag: aiModelFacet.imageTag,
  hasHfToken: sql<boolean>`${aiModelFacet.hfToken} is not null`,
};

/**
 * The Application settings the platform writes for an AI model at create
 * a `docker` source on the runtime's image for `gpus` per copy, and
 * its command, args, port and health check. The row is the deploy's truth
 * from then on; an edit of the model, the image tag or `gpus` rewrites what
 * it changes ({@link admitAiModelEdit}).
 */
export function aiModelApplicationSettings(facet: CreateAiModel, gpus: number) {
  const runtime = INFERENCE_RUNTIMES[facet.runtime];
  return {
    sourceType: 'docker' as const,
    dockerImage: runtimeImage(facet.runtime, facet.imageTag, gpus),
    command: runtime.command,
    args: runtime.args(facet.model, gpus),
    port: runtime.port,
    healthCheckSwarm: runtime.healthCheck,
  };
}

/** Writes the facet row beside its new Application, with its secret. */
export async function insertAiModel(
  tx: Db,
  applicationId: string,
  facet: CreateAiModel,
): Promise<AiModelRead> {
  const [row] = await tx
    .insert(aiModelFacet)
    .values({
      applicationId,
      runtime: facet.runtime,
      model: facet.model,
      imageTag: facet.imageTag ?? null,
      hfToken: facet.hfToken ?? null,
      upstreamSecret: randomBytes(32).toString('base64url'),
    })
    .returning(readColumns);
  return toFacet(row);
}

/**
 * The facet of `applicationId`, or `null` on a plain Application. Projected
 * by column: the upstream secret is never selected here.
 */
export async function readAiModelFacet(
  db: Db,
  applicationId: string,
): Promise<AiModelRead | null> {
  const [row] = await db
    .select(readColumns)
    .from(aiModelFacet)
    .where(eq(aiModelFacet.applicationId, applicationId))
    .limit(1);
  return row ? toFacet(row) : null;
}

function toFacet(row: {
  runtime: InferenceRuntime;
  model: string;
  imageTag: string | null;
  hasHfToken: boolean;
}): AiModelRead {
  return {
    runtime: row.runtime,
    model: row.model,
    imageTag: row.imageTag ?? INFERENCE_RUNTIMES[row.runtime].pinnedTag,
    pin: INFERENCE_RUNTIMES[row.runtime].pinnedTag,
    offPin: isOffPin(row.runtime, row.imageTag),
    hasHfToken: row.hasHfToken,
  };
}

/**
 * The env an AI model's deploy injects from its facet's secrets:
 * `HF_TOKEN` when a Hugging Face token is set, nothing otherwise. Read at
 * each release and Rollback, beside the runtime's own env, and never part of
 * the deploy's `aiModel`, so it never reaches a rollback's stored context.
 */
export async function hfTokenEnv(
  db: Db,
  applicationId: string,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({ hfToken: aiModelFacet.hfToken })
    .from(aiModelFacet)
    .where(eq(aiModelFacet.applicationId, applicationId))
    .limit(1);
  return row?.hfToken ? { HF_TOKEN: row.hfToken } : {};
}

/**
 * Admits an `aiModel` edit, and a `gpus` edit, on `PATCH /applications/:id`
 * and writes the facet's half, in the caller's transaction.
 * Answers with what the Application row must be rewritten with.
 *
 * An Application is an AI model from create for life, so a facet
 * given to a plain Application, a facet removed (`null`) and a runtime change
 * are each refused 409 before anything is written, as is a Hugging Face token
 * on a runtime that does not use one. A new image tag, or a GPU count that
 * moves vLLM or llama.cpp between its CPU and GPU builds, rewrites the row's
 * `dockerImage`; a new model, or a GPU count that turns llama.cpp's offload
 * on or off, rewrites its `args`, where vLLM and llama.cpp name the
 * model. Both are what the next deploy reads. A `gpus` edit on a plain
 * Application answers nothing.
 */
export async function admitAiModelEdit(
  db: Db,
  applicationId: string,
  edit: UpdateAiModel | null | undefined,
  gpus: number | undefined,
): Promise<{ dockerImage?: string; args?: string[] }> {
  if (edit === undefined && gpus === undefined) return {};
  const [current] = await db
    .select({
      runtime: aiModelFacet.runtime,
      model: aiModelFacet.model,
      imageTag: aiModelFacet.imageTag,
      gpus: application.gpus,
    })
    .from(aiModelFacet)
    .innerJoin(
      application,
      eq(application.applicationId, aiModelFacet.applicationId),
    )
    .where(eq(aiModelFacet.applicationId, applicationId))
    .limit(1);
  if (!current) {
    if (edit === undefined) return {};
    throw new ConflictException(
      'A plain Application cannot become an AI model; create an AI model instead',
    );
  }
  if (edit === null) {
    throw new ConflictException(
      'An AI model cannot stop being one; delete it to remove it',
    );
  }
  if (edit?.runtime !== undefined && edit.runtime !== current.runtime) {
    throw new ConflictException(
      "An AI model's inference runtime is fixed at create; create a new AI model to change it",
    );
  }
  if (edit?.hfToken && !INFERENCE_RUNTIMES[current.runtime].takesHfToken) {
    throw new ConflictException(
      `A Hugging Face token is for an AI model on ${HF_TOKEN_RUNTIMES_PHRASE}; this one does not use one`,
    );
  }
  const set: {
    model?: string;
    imageTag?: string | null;
    hfToken?: string | null;
  } = {};
  if (edit?.model !== undefined) set.model = edit.model;
  if (edit?.imageTag !== undefined) set.imageTag = edit.imageTag;
  if (edit?.hfToken !== undefined) set.hfToken = edit.hfToken || null;
  if (Object.keys(set).length > 0) {
    await db
      .update(aiModelFacet)
      .set(set)
      .where(eq(aiModelFacet.applicationId, applicationId));
  }
  const runtime = INFERENCE_RUNTIMES[current.runtime];
  return {
    ...((edit?.imageTag !== undefined || gpus !== undefined) && {
      dockerImage: runtimeImage(
        current.runtime,
        edit?.imageTag !== undefined ? edit.imageTag : current.imageTag,
        gpus ?? current.gpus,
      ),
    }),
    ...((edit?.model !== undefined || gpus !== undefined) && {
      args: runtime.args(edit?.model ?? current.model, gpus ?? current.gpus),
    }),
  };
}

/**
 * Puts the machine's Traefik on `cloudgate-ai` when the AI model about to be
 * created is the first on it: once, never on a later create, and never
 * by rolling Traefik. A Server set up since this facet landed already has it from Server
 * setup; one set up before gets it here. The program is idempotent, so a
 * create that fails after it leaves nothing to undo.
 *
 * `serverId` `null` is the platform host, whose Traefik is joined the same way.
 */
export async function joinAiNetworkForFirstAiModel(
  db: Db,
  remoteExec: RemoteExecService,
  serverId: string | null | undefined,
): Promise<void> {
  const [{ held }] = await db
    .select({ held: count() })
    .from(aiModelFacet)
    .innerJoin(
      application,
      eq(application.applicationId, aiModelFacet.applicationId),
    )
    .where(
      serverId
        ? eq(application.serverId, serverId)
        : isNull(application.serverId),
    );
  if (held > 0) return;
  await execOnServer(remoteExec, serverId, joinAiNetworkProgram());
}

/**
 * Records `model` as the one `applicationId`'s running version serves, once
 * a Deployment has it ready: what the gateway holds calls to from then on
 * (`aiModelFacet.servedModel`).
 */
export async function recordServedModel(
  db: DrizzleDB,
  applicationId: string,
  model: string,
): Promise<void> {
  await db
    .update(aiModelFacet)
    .set({ servedModel: model })
    .where(eq(aiModelFacet.applicationId, applicationId));
}
