import type { Response } from 'express';

/**
 * The Gateway's refusals, each in the shape an OpenAI client already reads
 * (`{"error":{"message","type","code"}}`), so a caller's SDK shows the
 * sentence rather than a parse error. Sentence case, no trailing period
 * (CODING_STANDARDS §2.5).
 */
export interface GatewayRefusal {
  readonly status: number;
  readonly message: string;
  readonly type: 'invalid_request_error' | 'server_error';
  readonly code: string;
}

/**
 * Unknown, revoked, expired, suspended or personal: one answer for all five,
 * so a key can't learn which.
 */
export const KEY_REFUSED: GatewayRefusal = {
  status: 401,
  message: 'Key refused',
  type: 'invalid_request_error',
  code: 'key_refused',
};

/**
 * A deleted AI model, one in another Organization, one outside the Agent's
 * grant, and a key without `call`: one answer, so a key can't map which AI
 * models exist.
 */
export const AI_MODEL_NOT_FOUND: GatewayRefusal = {
  status: 404,
  message: 'AI model not found or not permitted',
  type: 'invalid_request_error',
  code: 'model_not_found',
};

/** The four endpoints the Gateway forwards; everything else is refused 404. */
export const NOT_FORWARDED: GatewayRefusal = {
  status: 404,
  message:
    'The gateway forwards only POST /v1/chat/completions, POST /v1/completions, POST /v1/embeddings and GET /v1/models',
  type: 'invalid_request_error',
  code: 'unsupported_endpoint',
};

/** A body whose `model` is not the one served: refused, never rewritten. */
export const wrongModel = (served: string): GatewayRefusal => ({
  status: 400,
  message: `This AI model serves '${served}'; set "model" to it`,
  type: 'invalid_request_error',
  code: 'model_mismatch',
});

export const NOT_RUNNING: GatewayRefusal = {
  status: 503,
  message: 'AI model is not running',
  type: 'server_error',
  code: 'model_not_running',
};

/** The runtime could not be reached through its machine's Traefik. */
export const NOT_ANSWERING: GatewayRefusal = {
  status: 502,
  message: 'AI model did not answer',
  type: 'server_error',
  code: 'model_not_answering',
};

export function sendRefusal(res: Response, refusal: GatewayRefusal): void {
  if (refusal.status === 401) {
    res.setHeader('www-authenticate', 'Bearer');
  }
  res.status(refusal.status).json({
    error: { message: refusal.message, type: refusal.type, code: refusal.code },
  });
}
