import { ConflictException } from '@nestjs/common';

import type { CloudDeleteRecord } from './application.schema';

/**
 * The `code` of a 409 a cloud Service's Delete, Retry or Forget answers, so
 * the console and the MCP tools can tell it from a Server's Delete refusal.
 */
export const CLOUD_DELETE_REFUSED_CODE = 'CLOUD_DELETE_REFUSED';

/** Why Deploy and Start are refused on a Delete-incomplete Service (ADR-0038). */
export const DELETE_INCOMPLETE_REFUSAL =
  'This Service is Delete incomplete: its Infrastructure state still describes what is left in AWS, and a deploy would mix new resources into it. Retry the Delete, or Forget it';

/** Why Deploy and Start are refused while a Service's Delete runs. */
export const DELETING_REFUSAL =
  'This Service is being deleted: its Delete is a Cloud run destroying it in AWS';

/**
 * Deploy and Start refused while a cloud Delete runs or is incomplete
 * (ADR-0038): its state still describes what is left in AWS.
 */
export function refuseWhileCloudDelete(row: {
  cloudDelete: Pick<CloudDeleteRecord, 'status'> | null;
}): void {
  if (!row.cloudDelete) return;
  throw new ConflictException({
    message:
      row.cloudDelete.status === 'incomplete'
        ? DELETE_INCOMPLETE_REFUSAL
        : DELETING_REFUSAL,
    code: CLOUD_DELETE_REFUSED_CODE,
  });
}
