import { z } from 'zod';

/**
 * The error body every Cloudgate route outside `/api/auth/*` answers with
 * (`AllExceptionsFilter`, ADR 0005), as far as a client may rely on it.
 *
 * Loose on purpose: the filter adds fields (`pointer`, `details`, `output`)
 * that a given client has no use for, and a client must not fail to read a
 * refusal because the server learned to say more. A client branches on `code`
 * and never on `message`, which is English for a person and may be reworded;
 * `code` is present only where the server named the refusal.
 */
export const errorBodySchema = z.looseObject({
  statusCode: z.number().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

/**
 * The `code` of the 403 a request earns when its `x-organization-id` names an
 * Organization the caller is not a member of. Shared so the server
 * that refuses and the CLI that explains the refusal spell it once.
 */
export const NOT_ORGANIZATION_MEMBER_CODE = 'NOT_ORGANIZATION_MEMBER';
