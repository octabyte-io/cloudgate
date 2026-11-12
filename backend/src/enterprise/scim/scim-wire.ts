import type { NextFunction, Request, Response } from 'express';
import { APIError, isAPIError } from 'better-auth/api';

/**
 * The SCIM wire format, on the IdP-facing half of SCIM.
 *
 * That half is better-auth's plugin, mounted whole under `/api/auth` by
 * `AuthController`, and the plugin speaks SCIM correctly once a request reaches
 * it — its own errors are already RFC 7644 §3.12 errors. What it cannot fix is
 * what happens around it: Express's global JSON parser matches
 * `application/json` only, so a body sent as `application/scim+json` — the media
 * type RFC 7644 §3.1 defines, and the one Okta, Entra ID and OneLogin send —
 * arrived as `undefined`, and every create an identity provider made was refused
 * as `[body] Invalid input` before any SCIM code ran. And better-call stamps
 * every JSON response `application/json`, which §3.1 also says is not the type a
 * SCIM response carries.
 */

/** RFC 7644 §3.1's media type. `application/json` stays accepted alongside it. */
export const SCIM_MEDIA_TYPE = 'application/scim+json';

/** RFC 7644 §3.12's error message schema. */
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * Where the plugin's IdP-facing routes are mounted, for `ScimModule`'s
 * middleware. Only `/v2/*`: the plugin's session-authenticated management
 * routes under `/scim/*` are not SCIM protocol endpoints.
 */
export const SCIM_PROTOCOL_ROUTE = 'api/auth/scim/v2/*splat';

/**
 * The global JSON parser's own limit (body-parser's default, which Nest keeps),
 * so a SCIM body is bounded exactly as the same body sent as
 * `application/json` is.
 */
const BODY_LIMIT_BYTES = 100 * 1024;

/** An RFC 7644 §3.12 error body. */
export function scimError(status: number, detail: string, scimType?: string) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  };
}

class BodyTooLarge extends Error {}

async function readBody(req: Request): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  // RFC 8259 §8.1: JSON exchanged between systems is UTF-8.
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parses an `application/scim+json` body the global parser stepped over, and
 * answers in `application/scim+json`.
 *
 * Mounted on {@link SCIM_PROTOCOL_ROUTE} only, rather than widening the global
 * parser's `type` to `+json`: that parser is registered by Nest in `main.ts`
 * *and* rebuilt by `createTestApp`, so a change there is a change the harness
 * has to copy by hand (H-28's shape), and no other route in the product is
 * spoken to in a `+json` type. Module middleware runs after the global parsers
 * and before the router, so it sees exactly the requests the global one left
 * unparsed, and `AuthController.toWebRequest` re-serializes `req.body` as it
 * does for any other JSON body.
 *
 * A body that is not JSON is refused here in the SCIM error schema
 * (`invalidSyntax`), because this is the layer that found it; the plugin never
 * sees it. The same body sent as `application/json` is still refused by the
 * global parser in Cloudgate's generic shape — that parser runs first and is
 * not SCIM's to intercept.
 *
 * The response type is rewritten on `setHeader`, which is how both
 * `AuthController` (copying better-auth's headers) and Express's `res.send`
 * set it, so every SCIM response — success or error — carries the SCIM type.
 */
export async function scimWireFormat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  type HeaderValue = number | string | readonly string[];
  const setHeader = res.setHeader.bind(res) as (
    name: string,
    value: HeaderValue,
  ) => Response;
  res.setHeader = (name: string, value: HeaderValue) =>
    setHeader(
      name,
      name.toLowerCase() === 'content-type' && typeof value === 'string'
        ? value.replace(/^application\/json/i, SCIM_MEDIA_TYPE)
        : value,
    );

  if (req.body !== undefined || !req.is(SCIM_MEDIA_TYPE)) {
    next();
    return;
  }

  const refuse = (status: number, detail: string, scimType?: string) => {
    res
      .status(status)
      .type(SCIM_MEDIA_TYPE)
      .send(JSON.stringify(scimError(status, detail, scimType)));
  };

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLarge) {
      refuse(413, 'Request body is too large');
      return;
    }
    next(error);
    return;
  }
  // No body at all — a DELETE sent with the header, which is what a client
  // that sets it on every request does — is left `undefined`, as the global
  // parser leaves an empty `application/json` one.
  if (raw.trim() === '') {
    next();
    return;
  }
  try {
    req.body = JSON.parse(raw) as unknown;
  } catch {
    refuse(400, 'Request body is not valid JSON', 'invalidSyntax');
    return;
  }
  next();
}

/**
 * better-call's schema refusal, restated as a SCIM error on a SCIM route.
 * Run from `auth.config.ts`'s top-level `hooks.after`.
 *
 * better-call validates the body before the plugin's handler runs, so a create
 * missing `userName` was refused as `{ code: 'VALIDATION_ERROR', message }` — a
 * shape no SCIM client parses — while every refusal the plugin itself makes is
 * already a §3.12 error. `invalidValue` is §3.12's type for "a required value
 * was missing, or the value specified was not compatible", which is what a
 * schema refusal is. The message is kept as the `detail`, since it is the part
 * that names the attribute.
 */
export function restateScimValidationError(ctx: {
  path?: string;
  context: { returned?: unknown };
}): void {
  if (!ctx.path?.startsWith('/scim/v2/')) return;
  const returned = ctx.context.returned;
  if (!isAPIError(returned)) return;
  const body = returned.body as { code?: string; message?: string } | undefined;
  if (body?.code !== 'VALIDATION_ERROR') return;
  throw new APIError(
    'BAD_REQUEST',
    scimError(400, body.message ?? 'Invalid request', 'invalidValue'),
  );
}
