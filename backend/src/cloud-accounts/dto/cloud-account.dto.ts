import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A 12-digit AWS account id. */
export const awsAccountIdSchema = z
  .string()
  .trim()
  .regex(/^\d{12}$/, 'cloudId must be a 12-digit AWS account id');

/** An IAM role ARN; group 1 is its account id. */
const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

const roleArnSchema = (field: string) =>
  z
    .string()
    .trim()
    .regex(
      ROLE_ARN,
      `${field} must be an IAM role ARN (arn:aws:iam::<account id>:role/<name>)`,
    );

/** The account id an IAM role ARN names. */
export function accountOfRoleArn(arn: string): string | null {
  return ROLE_ARN.exec(arn)?.[1] ?? null;
}

/**
 * A Google Cloud project id: 6–30 characters, lowercase letters, digits and
 * hyphens, starting with a letter and not ending with a hyphen.
 */
export const gcpProjectIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    'cloudId must be a Google Cloud project id (6–30 lowercase letters, digits and hyphens)',
  );

/**
 * An OIDC provider's resource name, with or without Google's
 * `//iam.googleapis.com/` in front; group 1 is the name without it.
 */
const PROVIDER =
  /^(?:\/\/iam\.googleapis\.com\/)?(projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32})$/;

/** A service account's email. */
const SERVICE_ACCOUNT_EMAIL =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9.:-]+\.iam\.gserviceaccount\.com$/;

/**
 * Hands out the setup template for an AWS account not yet connected.
 * `setupToken` passes back a previous answer's token to keep its
 * external id — a corrected account id must not make the operator rebuild a
 * role they already made. `cloud` left out means AWS, as before a second
 * cloud existed.
 */
const setupAwsCloudAccountSchema = z.object({
  cloud: z.literal('aws').optional().default('aws'),
  cloudId: awsAccountIdSchema,
  setupToken: z.string().min(1).optional(),
});

/**
 * Hands out the setup script for a Google Cloud project (the Google Cloud spec). Its
 * token carries the key pair the script's JWKS holds, so passing it back
 * keeps the key, which a corrected project id would otherwise make the
 * operator upload again.
 */
const setupGcpCloudAccountSchema = z.object({
  cloud: z.literal('gcp'),
  cloudId: gcpProjectIdSchema,
  setupToken: z.string().min(1).optional(),
});

/** The setup for a Cloud account about to be connected, by its cloud. */
export const setupCloudAccountSchema = z.discriminatedUnion('cloud', [
  setupAwsCloudAccountSchema,
  setupGcpCloudAccountSchema,
]);
export type SetupCloudAccountInput = z.output<typeof setupCloudAccountSchema>;

/** The route's body class; see {@link CreateCloudAccountDto} for why it is a bare object. */
export class SetupCloudAccountDto extends (createZodDto(
  setupCloudAccountSchema,
) as unknown as new () => object) {}

/**
 * Connects an AWS account. The role ARNs must be in the typed account:
 * a role elsewhere would make every Service's place name an
 * account Cloudgate does not deploy into.
 *
 * `cloud` may be left out, as it could before a second cloud existed, and
 * then means AWS: an optional literal is what lets the discriminated union
 * below match a body without it (a `.default()` alone does not, since the
 * union reads the raw body's discriminator).
 */
const createAwsCloudAccountSchema = z
  .object({
    /** From `POST /cloud-accounts/setup`: the external id and id the template holds. */
    setupToken: z.string().min(1, 'setupToken cannot be empty'),
    name: z.string().trim().min(1, 'name cannot be empty').max(100),
    cloud: z.literal('aws').optional().default('aws'),
    cloudId: awsAccountIdSchema,
    accessKeyId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{16,128}$/, 'accessKeyId must be an AWS access key id'),
    secretAccessKey: z
      .string()
      .trim()
      .min(1, 'secretAccessKey cannot be empty'),
    deployRoleArn: roleArnSchema('deployRoleArn'),
    taskExecutionRoleArn: roleArnSchema('taskExecutionRoleArn'),
  })
  .superRefine((value, ctx) => {
    for (const field of ['deployRoleArn', 'taskExecutionRoleArn'] as const) {
      const account = accountOfRoleArn(value[field]);
      if (account !== null && account !== value.cloudId) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is in AWS account ${account}, not ${value.cloudId}`,
        });
      }
    }
  });

/**
 * Connects a Google Cloud project (the Google Cloud spec), with what the setup
 * script printed: the provider, kept as its resource name
 * `projects/<number>/…`, and the deploy service account. That the service
 * account is in the project is the connect check's first step, so its
 * refusal reads like the others'.
 */
const createGcpCloudAccountSchema = z.object({
  /** From `POST /cloud-accounts/setup`: the id and key pair the script holds. */
  setupToken: z.string().min(1, 'setupToken cannot be empty'),
  name: z.string().trim().min(1, 'name cannot be empty').max(100),
  cloud: z.literal('gcp'),
  cloudId: gcpProjectIdSchema,
  workloadIdentityProvider: z
    .string()
    .trim()
    .regex(
      PROVIDER,
      'workloadIdentityProvider must be a workload identity provider (projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>)',
    )
    .transform((value) => PROVIDER.exec(value)?.[1] ?? value),
  deployServiceAccount: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      SERVICE_ACCOUNT_EMAIL,
      'deployServiceAccount must be a service account email (<name>@<project>.iam.gserviceaccount.com)',
    ),
});

/** Connects a Cloud account, by its cloud (slice 6, S12). */
export const createCloudAccountSchema = z.discriminatedUnion('cloud', [
  createAwsCloudAccountSchema,
  createGcpCloudAccountSchema,
]);
export type CreateCloudAccountInput = z.output<typeof createCloudAccountSchema>;

/**
 * The route's body class. nestjs-zod types a DTO's instance as its schema's
 * output, which a class cannot extend when that is a union (TS2509, measured
 * in `schedule.dto.ts`), so the class is typed as a bare object and the
 * controller hands the service {@link CreateCloudAccountInput}. Validation
 * and the OpenAPI document read the schema at run time and see the union.
 */
export class CreateCloudAccountDto extends (createZodDto(
  createCloudAccountSchema,
) as unknown as new () => object) {}

/**
 * Edits an AWS Cloud account. Every field is optional and one left out keeps
 * its stored value — the secret access key above all, which the console never
 * has to send back (ADR-0019). Strict, so the AWS account id and the external
 * id, which never change, are refused rather than
 * silently dropped: a caller who sends one believes it changed something.
 *
 * The role ARNs' account is checked against the stored account id in the
 * service, since this schema does not know it.
 */
const updateAwsCloudAccountSchema = z.strictObject({
  cloud: z.literal('aws').optional().default('aws'),
  name: createAwsCloudAccountSchema.shape.name.optional(),
  accessKeyId: createAwsCloudAccountSchema.shape.accessKeyId.optional(),
  secretAccessKey: createAwsCloudAccountSchema.shape.secretAccessKey.optional(),
  deployRoleArn: roleArnSchema('deployRoleArn').optional(),
  taskExecutionRoleArn: roleArnSchema('taskExecutionRoleArn').optional(),
});

/**
 * Edits a Google Cloud account, by the AWS edit's rules: every
 * field optional, one left out keeps its stored value, and strict, so the
 * project id, its number, the key and the issuer — none of which an edit
 * changes — are refused rather than silently dropped. A changed provider or
 * service account reruns the connect check in the service.
 */
const updateGcpCloudAccountSchema = z.strictObject({
  cloud: z.literal('gcp'),
  name: createGcpCloudAccountSchema.shape.name.optional(),
  workloadIdentityProvider:
    createGcpCloudAccountSchema.shape.workloadIdentityProvider.optional(),
  deployServiceAccount:
    createGcpCloudAccountSchema.shape.deployServiceAccount.optional(),
});

/**
 * Edits a Cloud account, by its cloud (slice 6, S12), which must be the
 * stored one's; left out, it means AWS, as before a second cloud existed.
 */
export const updateCloudAccountSchema = z.discriminatedUnion('cloud', [
  updateAwsCloudAccountSchema,
  updateGcpCloudAccountSchema,
]);
export type UpdateCloudAccountInput = z.output<typeof updateCloudAccountSchema>;

/** The route's body class; see {@link CreateCloudAccountDto} for why it is a bare object. */
export class UpdateCloudAccountDto extends (createZodDto(
  updateCloudAccountSchema,
) as unknown as new () => object) {}
