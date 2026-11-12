import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { GatewayRefusal } from './gateway-refusals';

/**
 * The largest body a call to the Gateway may carry: 16 MiB, room for a long
 * context, a batch of embeddings or an image sent inline, where the
 * application-wide JSON parser stops at 100 kB.
 */
export const GATEWAY_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** The Gateway's calls, `/ai/<AI model>/<anything>`, and nothing else under `/ai`. */
const GATEWAY_CALL = /^\/ai\/[^/]+\/./;

/** Bodies the Gateway's reader could not take, by request, with what to answer. */
const refusedBodies = new WeakMap<Request, GatewayRefusal>();

export const BODY_TOO_LARGE: GatewayRefusal = {
  status: 413,
  message: `The request body is larger than the gateway takes (${GATEWAY_BODY_LIMIT_BYTES / 1024 / 1024} MiB)`,
  type: 'invalid_request_error',
  code: 'request_too_large',
};

export const BODY_NOT_JSON: GatewayRefusal = {
  status: 400,
  message: 'The request body is not valid JSON',
  type: 'invalid_request_error',
  code: 'invalid_json',
};

/** What to refuse a call with because of its body, if anything. */
export function gatewayBodyRefusal(req: Request): GatewayRefusal | undefined {
  return refusedBodies.get(req);
}

/**
 * Reads a Gateway call's JSON body, up to {@link GATEWAY_BODY_LIMIT_BYTES},
 * before the application-wide parser sees it (spec story 59).
 *
 * The application-wide parser would refuse anything over 100 kB itself, in
 * Nest's error shape and before the Gateway had a caller to write a row for.
 * So a body this cannot take is not refused here: it is read off and dropped,
 * noted, and the Gateway refuses the call once it knows the caller, in
 * OpenAI's shape and with a `refused` row like any refusal after
 * authentication. A request read here is finished, so the application-wide
 * parser passes it by.
 *
 * Registered with `app.use` before `init()`, where Nest adds its own parsers,
 * so it runs first: by `main.ts` and by `createTestApp`, out of this one
 * function.
 */
export function applyGatewayBodyParser(app: INestApplication): void {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (
      !GATEWAY_CALL.test(req.path) ||
      req.method === 'GET' ||
      req.method === 'HEAD'
    ) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Read to the end either way, so the refusal can be answered on a
      // connection that is still in step; only what fits is kept.
      if (size <= GATEWAY_BODY_LIMIT_BYTES) chunks.push(chunk);
    });
    req.on('error', next);
    req.on('end', () => {
      if (size > GATEWAY_BODY_LIMIT_BYTES) {
        refuse(req, BODY_TOO_LARGE);
      } else if (size > 0) {
        try {
          const body: unknown = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          );
          req.body = body;
        } catch {
          refuse(req, BODY_NOT_JSON);
        }
      } else {
        req.body = {};
      }
      next();
    });
  });
}

function refuse(req: Request, refusal: GatewayRefusal): void {
  refusedBodies.set(req, refusal);
  req.body = {};
}
