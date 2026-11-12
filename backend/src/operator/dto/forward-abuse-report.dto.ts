import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `POST /operator/organizations/:id/abuse-reports`: the report as the
 * owners and admins receive it, word for word.
 */
export const forwardAbuseReportSchema = z.object({
  report: z.string().trim().min(1, 'report cannot be empty').max(20_000),
});

export class ForwardAbuseReportDto extends createZodDto(
  forwardAbuseReportSchema,
) {}
