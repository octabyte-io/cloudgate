import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Revocation is asked for by **session id**, not by session token
 * (ADR-0009).
 *
 * better-auth's own `revokeSession` takes `{ token }`, which is why the listing
 * used to ship every session's live credential to the browser: the client was
 * handed the key purely so it could hand it back. The id names the same row and
 * is not a credential, so the token never has to leave the server.
 */
export const revokeSessionSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

export class RevokeSessionDto extends createZodDto(revokeSessionSchema) {}
