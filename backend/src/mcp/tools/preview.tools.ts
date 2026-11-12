import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { CONFIG_KIND_REFUSAL_CODE } from '../../applications/config-kind-locks';
import {
  CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE,
  CLOUD_PREVIEWS_REFUSAL,
} from '../../preview-deployments/cloud-preview';
import { createRequestedPreviewSchema } from '../../preview-deployments/dto/preview-deployment.dto';
import { PreviewDeploymentsController } from '../../preview-deployments/preview-deployments.controller';
import { PreviewDeploymentsService } from '../../preview-deployments/preview-deployments.service';
import type { PreviewDeploymentRead } from '../../preview-deployments/preview-deployments.service';
import {
  PREVIEW_EXPIRED_REFUSAL,
  REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES,
  REQUESTED_PREVIEW_REFUSAL_CODE,
  REQUESTED_PREVIEWS_NOT_ALLOWED,
} from '../../preview-deployments/requested-preview';
import type { PermissionCtx } from '../../rbac/permission.service';
import { defineTool } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import type { ErrorEntry } from '../tool-errors';
import { listOf, row } from '../tool-projection';
import type { FieldSpec } from '../tool-projection';
import { serviceRoot } from './service-kinds';

/**
 * The Requested-preview tools (ADR-0026): an Agent asks for a
 * copy of one Application built from a branch, reads it, extends it, rebuilds
 * it and kills it. Six tools on the preview row itself; its builds are read
 * and cancelled with the tools that take a `deploymentId`.
 *
 * - **Requested previews only.** A pull-request preview's id answers exactly
 *   as an unknown id does, on every tool and before any gated call
 *   ({@link requestedOnly}), and `list_previews` leaves pull-request previews
 *   out. Narrowing the tool surface narrows reach without a second
 *   authorization path (ADR-0023).
 * - **Reach is the grant on the parent.** Every service method authorizes
 *   against the parent Application; the requester is recorded, never checked,
 *   and comes back only as `requestedByYou`, never as an id.
 * - **Never returned** (ADR-0019, ADR-0024): env values, the requester's user
 *   id, the pull-request fields. The projection names what leaves; the mask
 *   walks from the parent's row.
 */

// ------------------------------------------------------------------ answers

/** One preview as the tools answer it, before its projection. */
export type PreviewAnswer = PreviewDeploymentRead & {
  /** Marked expired, by its clock or a delete: teardown pending. */
  expired: boolean;
  /** Whether the caller asked for it; the requester's id never leaves. */
  requestedByYou: boolean;
};

/** What `create_preview` and `redeploy_preview` answer: the build queued too. */
export type QueuedPreviewAnswer = PreviewAnswer & {
  deploymentId: string;
  message: string;
};

function answerOf(
  ctx: PermissionCtx,
  read: PreviewDeploymentRead,
): PreviewAnswer {
  return {
    ...read,
    expired: read.expiredAt !== null,
    requestedByYou: read.requesterId === ctx.user.id,
  };
}

const queuedMessage = (deploymentId: string) =>
  `Deployment \`${deploymentId}\` of this preview is queued; poll \`get_preview\` or \`list_deployments\` for its status, then call \`read_deployment_log\` with its deploymentId.`;

/**
 * A pull-request preview's id, or one with no row, answers here as a 404 —
 * which the error table folds into the one grant refusal — before the tool's
 * service call. The read is unscoped, and says nothing a missing id would
 * not: another Organization's Requested preview goes on to the gated call,
 * which refuses it the same way.
 */
async function requestedOnly(
  service: PreviewDeploymentsService,
  previewDeploymentId: string,
): Promise<void> {
  if ((await service.triggerOf(previewDeploymentId)) !== 'requested') {
    throw new NotFoundException();
  }
}

/** The preview fields: what the loop reads to follow, keep and kill a preview. */
const PREVIEW_FIELDS: ReadonlyArray<FieldSpec<PreviewAnswer>> = [
  'previewDeploymentId',
  'applicationId',
  'branch',
  'url',
  'urlNote',
  ['status', 'previewStatus'],
  'expired',
  'expiresAt',
  'latestDeploymentId',
  'requestedByYou',
  'createdAt',
];

const previewFields = row<PreviewAnswer>({ fields: PREVIEW_FIELDS });

const queuedFields = row<QueuedPreviewAnswer>({
  fields: [...PREVIEW_FIELDS, 'deploymentId', 'message'],
});

// ---------------------------------------------------------- what they say

/** Said by every tool: the preview that went, and whose grant reaches it. */
const REACH =
  'Reach is your grant on the parent Application. A preview that has gone, after it expired or was deleted, answers not found: stop rather than retry, and ask for a new one if you still need it.';

const applicationIdArg = z
  .string()
  .min(1)
  .describe("An Application's serviceId from get_environment");

const previewIdArg = z
  .string()
  .min(1)
  .describe('A previewDeploymentId from create_preview or list_previews');

/** The DTO's own field, as `branch` is below, so the tool and its twin
 * refuse the same shapes (§2.4). */
const ttlMinutesArg = createRequestedPreviewSchema.shape.ttlMinutes.describe(
  `How many minutes from now the preview lives: default ${REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES}, refused over this instance's maximum`,
);

const code = (
  exception: typeof ConflictException | typeof BadRequestException,
  refusal: keyof typeof REQUESTED_PREVIEW_REFUSAL_CODE,
  failed: string,
): ErrorEntry => ({
  exception,
  code: REQUESTED_PREVIEW_REFUSAL_CODE[refusal],
  answer: { failed },
});

/** The switch: the same sentence as HTTP's 409 (ADR-0026). */
const NOT_ALLOWED = code(
  ConflictException,
  'notAllowed',
  REQUESTED_PREVIEWS_NOT_ALLOWED,
);

/**
 * The cap. **No finality sentence**: deleting one or waiting
 * frees a slot, once the expired preview's teardown finishes (a delete is an
 * expiry). Fixed text, as every tool failure is (ADR-0024), so the
 * soonest expiry HTTP names is read off `list_previews` instead.
 */
const AT_LIMIT = code(
  ConflictException,
  'atLimit',
  "This Application already holds as many requested previews as its limit allows. Deleting one with delete_preview expires it now; a slot frees once an expired preview's teardown finishes, whether it was deleted or ran out its time, and list_previews shows each one's expiresAt. This Application's operator sets the limit.",
);

const NO_BRANCH = code(
  BadRequestException,
  'noBranch',
  "This Application's source has no branch to build, so it cannot have a requested preview.",
);

const OVER_MAX_TTL = code(
  BadRequestException,
  'overMaxTtl',
  `ttlMinutes is over this instance's maximum for a requested preview. Ask again with fewer minutes, or leave ttlMinutes out for ${REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES}; an operator sets the maximum.`,
);

/**
 * No preview wildcard and no IP recorded for the machine the preview would
 * run on, so its host would resolve nowhere. Nothing the Agent can
 * change: the fix is the operator's, and the text says which two it is.
 */
const NO_ADDRESS = code(
  BadRequestException,
  'noAddress',
  "This Application sets no preview wildcard and no IP is recorded for the machine its previews run on, so a preview would have no host that resolves. Its operator can set a preview wildcard on the Application, or record the machine's public IP.",
);

/**
 * The Application's recorded kind has no previews at all: a web-private
 * is reached only at its internal address, and a worker serves
 * no HTTP. Changing the kind is the way out, and only the operator's Project
 * config can do it.
 */
const KIND_TAKES_NO_PREVIEWS: ErrorEntry = {
  exception: ConflictException,
  code: CONFIG_KIND_REFUSAL_CODE.previews,
  answer: {
    failed:
      "This Application's kind has no previews: a preview is reached at a Domain of its own, and this kind takes none. Its operator can change its kind to web in the Project config.",
  },
};

/**
 * The Application runs in a Cloud account, which has no previews: a preview
 * would run on this Cloudgate's own host. Nothing the Agent can change.
 */
const IN_CLOUD: ErrorEntry = {
  exception: ConflictException,
  code: CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE,
  answer: { failed: CLOUD_PREVIEWS_REFUSAL },
};

const EXPIRED = code(
  ConflictException,
  'expired',
  `${PREVIEW_EXPIRED_REFUSAL} with create_preview.`,
);

// ------------------------------------------------------------------- tools

export const createPreview = defineTool({
  name: 'create_preview',
  title: 'Ask for a preview',
  description: `Asks for a requested preview: a copy of one Application built from a branch of its own repository, served at its own url until it expires (${REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES} minutes unless you give ttlMinutes). Answers as soon as its build is queued, with the preview and the queued deploymentId: poll get_preview or list_deployments, and read the build with read_deployment_log. Each call makes a new preview, even of the same branch. ${REACH}`,
  kind: 'write',
  input: z.object({
    applicationId: applicationIdArg,
    branch: createRequestedPreviewSchema.shape.branch.describe(
      "A branch of the Application's own repository",
    ),
    ttlMinutes: ttlMinutesArg,
  }),
  permissions: { deployment: ['create'] },
  twin: {
    controller: PreviewDeploymentsController,
    handler: 'createRequested',
  },
  target: { service: PreviewDeploymentsService, method: 'createRequested' },
  call: async (service, ctx, args): Promise<QueuedPreviewAnswer> => {
    const created = await service.createRequested(ctx, args.applicationId, {
      branch: args.branch,
      ttlMinutes: args.ttlMinutes,
    });
    return {
      ...answerOf(ctx, created),
      deploymentId: created.deploymentId,
      message: queuedMessage(created.deploymentId),
    };
  },
  targetId: 'applicationId',
  audit: { resourceType: 'previewDeployment', action: 'create' },
  projection: queuedFields,
  errors: [
    ...GRANT_REFUSALS,
    KIND_TAKES_NO_PREVIEWS,
    IN_CLOUD,
    NOT_ALLOWED,
    AT_LIMIT,
    NO_BRANCH,
    OVER_MAX_TTL,
    NO_ADDRESS,
  ],
  maskRoots: (args) => [
    serviceRoot({ serviceType: 'application', serviceId: args.applicationId }),
  ],
  auditDetail: (_args, raw) => ({
    previewDeploymentId: raw.previewDeploymentId,
    deploymentId: raw.deploymentId,
  }),
});

export const listPreviews = defineTool({
  name: 'list_previews',
  title: 'List previews',
  description: `Lists an Application's requested previews, newest first, each with its url, status, whether it has expired, expiresAt, its latest build's deploymentId and whether you asked for it. Previews a pull request opened are not listed. An expired preview is listed until its copy is gone. ${REACH}`,
  kind: 'read',
  input: z.object({ applicationId: applicationIdArg }),
  permissions: { deployment: ['read'] },
  twin: {
    controller: PreviewDeploymentsController,
    handler: 'findAllByApplication',
  },
  target: {
    service: PreviewDeploymentsService,
    method: 'findAllByApplicationId',
  },
  call: async (service, ctx, args): Promise<PreviewAnswer[]> => {
    const previews = await service.findAllByApplicationId(
      ctx,
      args.applicationId,
    );
    return previews
      .filter((preview) => preview.trigger === 'requested')
      .map((preview) => answerOf(ctx, preview));
  },
  targetId: 'applicationId',
  audit: { resourceType: 'previewDeployment', action: 'read' },
  projection: listOf(previewFields),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [
    serviceRoot({ serviceType: 'application', serviceId: args.applicationId }),
  ],
});

const byIdInput = z.object({ previewDeploymentId: previewIdArg });

/** The parent's row, which the mask walks from. */
const parentRoot = (found: { applicationId: string }) => [
  serviceRoot({ serviceType: 'application', serviceId: found.applicationId }),
];

export const getPreview = defineTool({
  name: 'get_preview',
  title: 'Get a preview',
  description: `Reads one requested preview: its url, status, whether it has expired, expiresAt, its latest build's deploymentId and whether you asked for it. Poll it to follow a build. An expired preview reads expired: true until its copy is gone. ${REACH}`,
  kind: 'read',
  input: byIdInput,
  permissions: { deployment: ['read'] },
  twin: { controller: PreviewDeploymentsController, handler: 'findOne' },
  target: { service: PreviewDeploymentsService, method: 'findOne' },
  call: async (service, ctx, args): Promise<PreviewAnswer> => {
    await requestedOnly(service, args.previewDeploymentId);
    return answerOf(ctx, await service.findOne(ctx, args.previewDeploymentId));
  },
  targetId: 'previewDeploymentId',
  audit: { resourceType: 'previewDeployment', action: 'read' },
  projection: previewFields,
  errors: GRANT_REFUSALS,
  maskRoots: (_args, found) => parentRoot(found),
});

export const extendPreview = defineTool({
  name: 'extend_preview',
  title: 'Extend a preview',
  description: `Moves a requested preview's expiry to ${REQUESTED_PREVIEW_DEFAULT_TTL_MINUTES} minutes from now, or ttlMinutes from now: a new window from now, not added to what is left. An expired preview cannot be extended. ${REACH}`,
  kind: 'write',
  input: byIdInput.extend({ ttlMinutes: ttlMinutesArg }),
  permissions: { deployment: ['create'] },
  twin: { controller: PreviewDeploymentsController, handler: 'extend' },
  target: { service: PreviewDeploymentsService, method: 'extend' },
  call: async (service, ctx, args): Promise<PreviewAnswer> => {
    await requestedOnly(service, args.previewDeploymentId);
    const extended = await service.extend(ctx, args.previewDeploymentId, {
      ttlMinutes: args.ttlMinutes,
    });
    return answerOf(ctx, extended);
  },
  targetId: 'previewDeploymentId',
  audit: { resourceType: 'previewDeployment', action: 'update' },
  projection: previewFields,
  errors: [...GRANT_REFUSALS, NOT_ALLOWED, EXPIRED, NO_BRANCH, OVER_MAX_TTL],
  maskRoots: (_args, found) => parentRoot(found),
});

export const redeployPreview = defineTool({
  name: 'redeploy_preview',
  title: 'Rebuild a preview',
  description: `Queues a rebuild of a requested preview from its branch as it is now, and answers the queued deploymentId: poll get_preview or list_deployments, and read the build with read_deployment_log. If its build is still waiting in the queue, that one is answered and nothing more is queued. It never moves the expiry. ${REACH}`,
  kind: 'write',
  input: byIdInput,
  permissions: { deployment: ['create'] },
  twin: { controller: PreviewDeploymentsController, handler: 'redeploy' },
  // The twin's gates once, and the read off the row they read (ADR-0023).
  target: { service: PreviewDeploymentsService, method: 'redeployAndRead' },
  call: async (service, ctx, args): Promise<QueuedPreviewAnswer> => {
    await requestedOnly(service, args.previewDeploymentId);
    const { deployment, read } = await service.redeployAndRead(
      ctx,
      args.previewDeploymentId,
    );
    return {
      ...answerOf(ctx, read),
      deploymentId: deployment.deploymentId,
      message: queuedMessage(deployment.deploymentId),
    };
  },
  targetId: 'previewDeploymentId',
  audit: { resourceType: 'previewDeployment', action: 'redeploy' },
  projection: queuedFields,
  errors: [...GRANT_REFUSALS, IN_CLOUD, NOT_ALLOWED, EXPIRED],
  maskRoots: (_args, found) => parentRoot(found),
  auditDetail: (_args, raw) => ({ deploymentId: raw.deploymentId }),
});

export const deletePreview = defineTool({
  name: 'delete_preview',
  title: 'Delete a preview',
  description: `Expires a requested preview now and answers at once with expired: true: its builds are cancelled and its copy is torn down within about a minute, after which it answers not found. Calling it again changes nothing. ${REACH}`,
  kind: 'write',
  input: byIdInput,
  permissions: { deployment: ['cancel'] },
  twin: { controller: PreviewDeploymentsController, handler: 'remove' },
  target: { service: PreviewDeploymentsService, method: 'remove' },
  call: async (service, ctx, args): Promise<PreviewAnswer> => {
    await requestedOnly(service, args.previewDeploymentId);
    return answerOf(ctx, await service.remove(ctx, args.previewDeploymentId));
  },
  targetId: 'previewDeploymentId',
  audit: { resourceType: 'previewDeployment', action: 'delete' },
  projection: previewFields,
  errors: GRANT_REFUSALS,
  maskRoots: (_args, found) => parentRoot(found),
});

export const PREVIEW_TOOLS = [
  createPreview,
  listPreviews,
  getPreview,
  extendPreview,
  redeployPreview,
  deletePreview,
];
