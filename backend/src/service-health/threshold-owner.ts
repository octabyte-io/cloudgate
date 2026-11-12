import type { ErrorRateOwner } from './error-rate-index';
import { errorRateThreshold } from './error-rate-threshold.schema';
import type { ErrorRateThreshold } from './error-rate-threshold.schema';

/**
 * The two Service kinds an Error-rate threshold can belong to: the two
 * that can have an Error rate. A Database is refused.
 */
export type ThresholdServiceType = ErrorRateOwner['serviceType'];

export const isThresholdServiceType = (
  serviceType: string,
): serviceType is ThresholdServiceType =>
  serviceType === 'application' || serviceType === 'compose';

/** The threshold column each owner kind hangs off. */
export const THRESHOLD_OWNER_COLUMN = {
  application: errorRateThreshold.applicationId,
  compose: errorRateThreshold.composeId,
} as const;

/**
 * The owning Service, read through the column the discriminant names
 * (`error_rate_threshold_parent_matches_service_type` makes them agree).
 */
export function thresholdOwnerOf(
  threshold: Pick<
    ErrorRateThreshold,
    'serviceType' | 'applicationId' | 'composeId'
  >,
): ErrorRateOwner {
  return threshold.serviceType === 'application'
    ? {
        serviceType: 'application',
        serviceId: threshold.applicationId as string,
      }
    : { serviceType: 'compose', serviceId: threshold.composeId as string };
}
