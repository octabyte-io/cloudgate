import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The host `GET /settings/runtime-info` describes: a Server, or the platform
 * host when absent (ADR-0008 — `checkServerAccess` returns undefined for an
 * absent id, and that is the contract across the whole HTTP surface).
 *
 * Its own file rather than a line in `settings.dto.ts`, and `.nullish()` rather
 * than `.optional()`: a console that has no Server selected sends
 * `serverId=null` through its JSON client as readily as it omits the key, and
 * `.optional()` alone rejects the first with a 400 that reads as a bug in the
 * page.
 */
export class RuntimeInfoQueryDto extends createZodDto(
  z.object({ serverId: z.string().nullish() }),
) {}
