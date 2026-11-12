import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CONFIG_NAME_REGEX } from '../../project-config/format/config-schema';

/**
 * A bucket name either cloud could take: lowercase letters, digits, dots,
 * hyphens and (on Google Cloud) underscores. Which one the Environment's
 * Cloud account takes is the service's to check: the body does not
 * say the cloud.
 */
const ANY_BUCKET_NAME = /^(?=.{3,222}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * "Use an existing bucket" (ADR-0033): an Environment's `bucket` entry
 * stands for a bucket the operator already has — an S3 bucket on AWS, a
 * Cloud Storage bucket on Google Cloud. `configName` is the entry's,
 * typically from the plan row that would create it; the Project config is
 * not changed.
 */
export const createExistingBucketSchema = z
  .object({
    environmentId: z.string().min(1, 'environmentId cannot be empty'),
    configName: z
      .string()
      .regex(
        CONFIG_NAME_REGEX,
        'configName must be a Config name: lowercase letters, digits and hyphens, starting with a letter',
      ),
    /** The bucket's name (`acme-prod-uploads`). */
    bucketName: z
      .string()
      .regex(
        ANY_BUCKET_NAME,
        'bucketName must be a bucket name: lowercase letters, digits, dots and hyphens (and underscores on Google Cloud), starting and ending with a letter or digit',
      ),
  })
  .strict();

export class CreateExistingBucketDto extends createZodDto(
  createExistingBucketSchema,
) {}
