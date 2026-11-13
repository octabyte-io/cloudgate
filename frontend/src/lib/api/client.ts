import { API_PREFIX, backendOrigin } from "@/lib/config";

import { ApiError, pointerOf, retryAfterSeconds } from "./api-error";
import type { ApiErrorBody } from "./api-error";

/**
 * The one way this app talks to the backend. Every query hook and every
 * mutation goes through here — no feature writes its own `fetch`.
 *
 * What it takes care of, so nothing downstream has to:
 *
 * - the session cookie (`credentials: "include"`)
 * - JSON in and out, including empty 204 bodies
 * - `AbortSignal`, so TanStack Query can cancel in flight
 * - the backend's error body, normalised into a typed `ApiError`
 */

/**
 * Query-string values a route actually accepts. `undefined` is dropped; a list
 * repeats its key once per item (`?status=a&status=b`), the shape the
 * backend's list query schemas normalise.
 */
export type QueryParams = Record<
  string,
  string | number | boolean | readonly string[] | undefined | null
>;

export interface RequestOptions {
  query?: QueryParams;
  signal?: AbortSignal;
  /** Extra headers. `Content-Type` is set for you when there is a body. */
  headers?: HeadersInit;
}

interface FullRequest extends RequestOptions {
  method: string;
  body?: unknown;
}

async function send(path: string, init: FullRequest): Promise<Response> {
  const hasBody = init.body !== undefined;
  // A multipart body goes as it is: `fetch` writes the boundary into its own
  // Content-Type, so setting one here would break it (see `postForm`).
  const isForm = init.body instanceof FormData;

  const response = await fetch(url(path, init.query), {
    method: init.method,
    // The session lives in a cookie. Without this the browser sends nothing and
    // every authenticated route answers 401.
    credentials: "include",
    /**
     * **No HTTP cache in front of TanStack Query** (added by F13).
     *
     * Nest runs on Express, which puts a weak `ETag` on every JSON response, so
     * the browser stores the body and revalidates the next identical GET with
     * `If-None-Match` — and Express answers **304**. `Response.ok` is false for a
     * 304, so the throw below turns "nothing has changed" into an
     * `ApiError(304)`: a refusal manufactured for a request whose data was
     * correct and already in the browser's hand. F13 saw real 304s in the
     * backend's own log for this app's GETs, which is what makes the hazard
     * reachable rather than theoretical.
     *
     * `no-store` closes it at the right layer, rather than teaching the client to
     * interpret a 304 and guess where the body went: **this app already has a
     * cache**, keyed and invalidated per Organization by `keys.ts` and
     * `use-invalidate.ts`. A second cache in front of it, with its own
     * revalidation rules and no idea when a mutation invalidated something, can
     * only ever disagree with the first.
     */
    cache: "no-store",
    signal: init.signal,
    headers: {
      Accept: "application/json",
      ...(hasBody && !isForm ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: isForm
      ? (init.body as FormData)
      : hasBody
        ? JSON.stringify(init.body)
        : undefined,
  });

  if (!response.ok) throw await toApiError(response, init.method);
  return response;
}

async function request<T>(path: string, init: FullRequest): Promise<T> {
  return (await readJson(await send(path, init))) as T;
}

/**
 * Absolute in the browser only in the sense that it is same-origin — the
 * rewrite in `next.config.ts` forwards it to Nest. On the server there is no
 * origin to be relative to, so Nest's own origin is used; nothing in this app
 * fetches data server-side today, but a relative URL there would throw a much
 * less obvious error than a wrong host would.
 */
function url(path: string, query?: QueryParams): string {
  const base = typeof window === "undefined" ? backendOrigin() : API_PREFIX;
  const search = toSearchParams(query);
  return `${base}${path}${search ? `?${search}` : ""}`;
}

function toSearchParams(query?: QueryParams): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value as readonly string[]) params.append(key, item);
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * `AllExceptionsFilter` answers with a JSON body on every failure, so the happy
 * path here is parsing it. A body that is missing or is not that shape means
 * something in front of Nest answered — a proxy, a crash — and the status code
 * is all there is to go on.
 */
async function toApiError(
  response: Response,
  method: string,
): Promise<ApiError> {
  const body = (await readJson(response)) as Partial<ApiErrorBody> | undefined;

  if (body && typeof body.message === "string") {
    return new ApiError(response.status, body.message, {
      issues: Array.isArray(body.details) ? body.details : [],
      path: typeof body.path === "string" ? body.path : "",
      // Optional on the wire and absent from almost every refusal (H-26), so
      // the `typeof` is the whole of the handling: a body without one becomes
      // an `ApiError` whose `code` is `""`, which is what every reader of it
      // already expects.
      code: typeof body.code === "string" ? body.code : "",
      retryAfter: retryAfterSeconds(response.headers),
      pointer: pointerOf(body.pointer),
      method,
      output: typeof body.output === "string" ? body.output : "",
    });
  }

  return new ApiError(
    response.status,
    response.statusText || `Request failed with status ${response.status}`,
    // A throttle in front of Nest answers without Nest's body, so the header
    // has to be read on this branch too.
    { retryAfter: retryAfterSeconds(response.headers), method },
  );
}

/** `undefined` for 204 and for anything that is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),

  /**
   * For the routes that answer with a bare string rather than JSON — parsing
   * one as JSON would quietly yield `undefined`.
   *
   * **Do not infer the content type from the return type; it is not uniform.**
   * `GET /deployments/:id/logs` is `text/plain`, but only because the
   * controller sets it on the way out — a Nest route that just returns a
   * `string` gets Express's default of `text/html` instead. Either way the body
   * is a string, which is all this method needs.
   */
  getText: (path: string, options?: RequestOptions) =>
    send(path, { ...options, method: "GET" }).then((response) =>
      response.text(),
    ),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body: body ?? {} }),

  /**
   * The same, for a POST that answers with a bare string.
   *
   * `POST /domains/generate` is the one: `generateDomain` returns
   * `Promise<string>` and the route sets no type of its own, so it goes out as
   * Express's default `text/html`, and `post<string>` handed back `undefined` —
   * which reached a form field and crashed the dialog on `undefined.trim()`.
   * F02's own note about `getText` was right and one method short.
   * **A route typed `Promise<string>` in Nest needs one of these two.**
   */
  postText: (path: string, body?: unknown, options?: RequestOptions) =>
    send(path, { ...options, method: "POST", body: body ?? {} }).then(
      (response) => response.text(),
    ),

  /**
   * A multipart POST, for the one kind of route that takes a file:
   * `POST /applications/:id/drop` reads its archive off the `zip` part.
   * The answer is JSON like any other.
   */
  postForm: <T>(path: string, form: FormData, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body: form }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body: body ?? {} }),

  /**
   * **Added by F18.** The enterprise controllers are the first to use PUT:
   * `PUT /sso/providers/:providerId`, `PUT /sso/trusted-origins` and
   * `PUT /forward-auth/settings` are all full replacements, so sending them as
   * PATCH would reach a route that does not exist.
   */
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT", body: body ?? {} }),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),

  /**
   * **Added by F18**, for the one route in the app that identifies what to
   * delete in a **body** rather than in the path:
   * `DELETE /sso/trusted-origins` takes `{ origin }`, because a trusted origin
   * is a string in a `jsonb` array on the owner's user row and has no id to put
   * in a URL. Separate from `delete` rather than an optional argument, so the
   * unusual shape is visible at the call site.
   */
  deleteWithBody: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE", body }),
};
