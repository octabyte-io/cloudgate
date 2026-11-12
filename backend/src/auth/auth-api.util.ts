import type { IncomingHttpHeaders } from 'node:http';
import { HttpException } from '@nestjs/common';
import { APIError } from 'better-auth/api';

/**
 * Runs a better-auth API call, translating its APIError to an HttpException.
 *
 * The `code` is carried across, and flattening it away was the H-26 defect one
 * layer in from `AllExceptionsFilter` (see `ErrorResponseBody.code`). Every
 * refusal better-auth raises names itself, and several of them are **403** —
 * `SESSION_NOT_FRESH`, `YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION`,
 * `ORGANIZATION_MEMBERSHIP_LIMIT_REACHED` — while the console has exactly one
 * sentence for a 403: *"Your role in this Organization does not allow this."*
 * Reached through better-auth's own client those codes arrive and
 * `errorMessage()` says the right thing; reached through a Cloudgate route they
 * were flattened to the message here, so the same refusal read as a role
 * problem depending only on which door it came through.
 *
 * `frontend/src/features/settings/account/sessions-card.tsx` is what this is
 * worth: it matched `SESSION_NOT_FRESH`'s **English** with a regex, called
 * itself "the last string match left in the app", and named this function's
 * flattening as the reason it had to. H-36 deleted that match, so the claim is
 * now true of nothing — and it is this line that has to hold for it to stay
 * true.
 *
 * **Rejected: publishing only the codes the console branches on.** That is the
 * rule `AllExceptionsFilter` and `refusalException()` follow, and it is right
 * for a refusal *Cloudgate* raises, where a code is a promise somebody had to
 * decide to make. It is the wrong rule here: better-auth already named every
 * one of these, on its own surface, to the same console — so the allowlist
 * would not be deciding what to publish, it would be deciding which door
 * publishes what better-auth published, which is the defect restated.
 */
export async function callAuthApi<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof APIError) {
      throw new HttpException(
        {
          message: error.body?.message ?? error.message,
          ...(error.body?.code ? { code: error.body.code } : {}),
        },
        error.statusCode,
      );
    }
    throw error;
  }
}

export function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(key, item);
    } else if (value !== undefined) {
      webHeaders.set(key, value);
    }
  }
  return webHeaders;
}
