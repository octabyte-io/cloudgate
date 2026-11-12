import { z } from 'zod';

import { CliError, refusalFromResponse } from './errors.js';
import type { RefusalContext } from './errors.js';
import { notUnderstood, parseJson, reach, USER_AGENT } from './http.js';
import { instanceEndpoints } from './instance.js';

/** The marker {@link ApiClient.getText} passes for an answer kept as text. */
const PLAIN_TEXT = z.string();

export interface ApiClientOptions {
  /** The Instance address, as chosen by `chooseInstance`. */
  instance: string;
  /** A Personal key, sent as `x-api-key`. */
  key: string;
  /**
   * The Organization the request acts in, sent as `x-organization-id`.
   * Omitted, the Instance acts in the key owner's default Organization.
   */
  organizationId?: string;
  /** What a refusal's hint may say (where the key came from, the Organization's name). */
  refusal?: RefusalContext;
  /**
   * What a 401 becomes instead of the Instance's own refusal. A saved login
   * passes one that forgets the login and says it has ended.
   */
  onKeyRefused?: () => Promise<CliError>;
  fetch: typeof fetch;
}

/**
 * The CLI's hand-written client of an Instance's REST surface (CLI spec):
 * one method per verb, each answer parsed with the `api-schemas` zod object
 * the backend declares it with. Not generated from `openapi.json`, which
 * cannot describe the upload and has almost no response schemas.
 *
 * Every way a request can fail ends as a {@link CliError} with the exit code
 * the spec fixes: an unreachable Instance and an answer this CLI cannot read
 * exit 1, a refusal exits as {@link refusalFromResponse} decides.
 */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  /**
   * The same client acting in `organizationId`: every request then carries
   * `x-organization-id`, which the Instance checks against the key owner's
   * memberships.
   */
  inOrganization(organizationId: string, organizationName?: string): ApiClient {
    return new ApiClient({
      ...this.options,
      organizationId,
      refusal: {
        ...this.options.refusal,
        ...(organizationName ? { organizationName } : {}),
      },
    });
  }

  get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    return this.request('GET', path, schema);
  }

  /**
   * A GET whose answer is plain text (a Deployment log's tail), given
   * back as it came; a refusal is still the Instance's JSON error.
   */
  getText(path: string): Promise<string> {
    return this.request('GET', path, PLAIN_TEXT);
  }

  /** A JSON `PATCH`, its answer parsed with `schema`. */
  patch<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    return this.request('PATCH', path, schema, body);
  }

  /**
   * A POST with a JSON body, or with `FormData` for a multipart upload (the
   * drop's `zip` part), whose boundary `fetch` writes itself.
   */
  post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    return this.request('POST', path, schema, body);
  }

  /**
   * The headers a WebSocket to this Instance carries: the same key and
   * Organization as every request (the Deployment log stream authenticates
   * with them, `validateRequest`).
   */
  socketHeaders(): Record<string, string> {
    const headers = this.headers();
    delete headers.accept;
    return headers;
  }

  /** A `DELETE`, its answer parsed with `schema`. */
  delete<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    return this.request('DELETE', path, schema);
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      'x-api-key': this.options.key,
      ...(this.options.organizationId
        ? { 'x-organization-id': this.options.organizationId }
        : {}),
    };
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const { instance } = this.options;
    const headers = this.headers();
    let payload: RequestInit['body'];
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const response = await reach(
      instance,
      this.options.fetch,
      `${instanceEndpoints(instance).rest}${path}`,
      {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      },
    );

    const answered = await response.text();
    const answer = parseJson(answered);
    if (response.status === 401 && this.options.onKeyRefused) {
      throw await this.options.onKeyRefused();
    }
    if (!response.ok) {
      throw refusalFromResponse(response.status, answer, this.options.refusal);
    }
    if ((schema as z.ZodType) === PLAIN_TEXT) return answered as z.infer<S>;
    const parsed = schema.safeParse(answer);
    if (!parsed.success) {
      throw notUnderstood(
        instance,
        `${method} ${path}`,
        'Check that the address is a Cloudgate console.',
      );
    }
    return parsed.data;
  }
}

/**
 * A POST to an Instance with no key, for the two routes a login is made with
 * (`/auth/device/code`, `/auth/device/token`). Answers the status and
 * the parsed body whatever the status, since the poll's 400s are its
 * protocol; only an Instance that cannot be reached is a failure here.
 */
export async function postWithoutKey(input: {
  instance: string;
  path: string;
  body: unknown;
  fetch: typeof fetch;
}): Promise<{ status: number; body: unknown }> {
  const response = await reach(
    input.instance,
    input.fetch,
    `${instanceEndpoints(input.instance).rest}${input.path}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(input.body),
    },
  );
  return { status: response.status, body: parseJson(await response.text()) };
}
