/**
 * The backend's one error shape. `AllExceptionsFilter` catches everything and
 * answers with this body, so the client has exactly one thing to parse
 * (`backend/src/common/filters/all-exceptions.filter.ts`).
 */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  /**
   * Which refusal this is, when the status alone does not say. Present only
   * where the backend decided the client has to branch on it — the ban (H-26)
   * and, since X11-4, a docker or swarm read whose target was never reached,
   * which is two codes rather than one: *which* machine was not
   * reached is part of which refusal this is, because it decides which sentence
   * is true. See `ApiError.code`.
   */
  code?: string;
  /** Present only on a 400 from the global ZodValidationPipe. */
  details?: { path: string; message: string }[];
  /**
   * Where a refused change is made instead (ADR-0005): the file and
   * branch of a repository-kept Project config, on
   * `PROJECT_CONFIG_REPOSITORY_KEPT` and `CONFIG_UNREADABLE`. See
   * `ApiError.pointer`.
   */
  pointer?: ConfigPointer;
  /**
   * A tool's own output behind a refusal whose `message` already says it in
   * plain words — a registry test's `docker login` stderr. See
   * `ApiError.output`.
   */
  output?: string;
  path: string;
  timestamp: string;
}

/**
 * A repository-kept Project config's file, where a refused change is made
 * instead: the repository, the path, the branch the Environment reads (`null`
 * only when the repository could not be reached), and a link to the file at
 * the commit read (`null` when it could not be read).
 */
export interface ConfigPointer {
  repository: string;
  path: string;
  branch: string | null;
  fileUrl: string | null;
}

/** A body's `pointer`, only in its published shape. */
export function pointerOf(value: unknown): ConfigPointer | null {
  if (typeof value !== "object" || value === null) return null;
  const { repository, path, branch, fileUrl } = value as Record<string, unknown>;
  if (typeof repository !== "string" || typeof path !== "string") return null;
  return {
    repository,
    path,
    branch: typeof branch === "string" ? branch : null,
    fileUrl: typeof fileUrl === "string" ? fileUrl : null,
  };
}

/**
 * The `code` the docker and swarm reads publish when the machine they were
 * pointed at was never reached (X11-4).
 *
 * The second code on this contract, and it is here for H-26's reason rather
 * than by analogy with it: **the status alone says the wrong thing.** A 503
 * gets `errorMessage()`'s *"The backend is not answering"*, which is a confident
 * statement about the wrong machine — the backend answered in 28 ms, and what
 * it could not reach was a Server. Before the code existed the route answered
 * `200 []` instead, and the console said *"Docker answered and there are no
 * containers on this host"* about a host at `127.0.0.1:1`.
 *
 * `backend/src/docker-ops/host-reachability.ts` publishes it and carries the
 * argument for the status. Matching its `message` would have worked and is the
 * pattern `auth-error.ts` records as deleted.
 */
const HOST_UNREACHABLE = "HOST_UNREACHABLE";

/**
 * The same fact about **the platform host** — the machine Cloudgate runs on
 * itself, which is what a docker read with no `serverId` addresses.
 *
 * The third code on this contract, and it exists because the second one was
 * doing two jobs. `host-reachability.ts` had one code and two sentences — *"This
 * Server could not be reached"* and *"The platform host could not be reached"* —
 * and everything on this side branches on the code, so `errorMessage()` said the
 * *Server* sentence for a platform-host failure: *"Cloudgate could not reach that
 * Server … check that its SSH key still works"*, which names a machine that is
 * not involved and a credential the platform host does not use. `LiveCard` in
 * `features/monitoring/` reaches it by construction — `dockerApi.containers(null)`
 * has no server id to give.
 *
 * That is H-26's defect and X11-4's own, one turn further in: **a refusal the
 * backend went to the trouble of naming must not be given the words of a
 * different refusal.** Two subjects with two sentences are two refusals, so they
 * are two codes.
 *
 * **Rejected: reading `?serverId=` out of {@link ApiError.path}.** The id is
 * right there — `path` is `request.url` — and taking it would make the console
 * re-derive from a URL string a fact the backend already knows and already
 * publishes. It is the same shape as matching `message`, which
 * `auth-error.ts` records as deleted, and it is
 * wrong on the routes that take `serverId` in a body or a multipart field
 * rather than a query string.
 */
const PLATFORM_HOST_UNREACHABLE = "PLATFORM_HOST_UNREACHABLE";

/**
 * The `code` a catalogue read publishes while templates are off on the
 * instance: `CLOUDGATE_TEMPLATES_URL=off`, or only the old
 * `CLOUDGATE_TEMPLATES_BASE_URL` set (ADR-0066). The status alone would get
 * *"The backend is not answering"* — about a backend that answered.
 * `backend/src/templates/templates.service.ts` publishes it; its message
 * says which setting and what to set.
 */
const TEMPLATES_CATALOGUE_NOT_CONFIGURED = "TEMPLATES_CATALOGUE_NOT_CONFIGURED";

/**
 * The codes a row-level refusal publishes, and the subject each one names.
 *
 * A member reaches a Project, an Environment or a Service only when Members →
 * Manage access has granted it, and that is a different axis from their role —
 * the dialog itself says *"Their role decides what they can do; this decides
 * what they can see at all."* Both refusals were an uncoded 403, so the console
 * named the role for both and sent an owner to change it, whose only working
 * form is a promotion to admin. `backend/src/rbac/permission.service.ts`'s
 * `ACCESS_NOT_GRANTED_CODE` publishes these; the role's own refusal publishes
 * none, and keeps the role sentence.
 */
const ACCESS_NOT_GRANTED: Record<string, "Project" | "Environment" | "Service"> =
  {
    PROJECT_ACCESS_NOT_GRANTED: "Project",
    ENVIRONMENT_ACCESS_NOT_GRANTED: "Environment",
    SERVICE_ACCESS_NOT_GRANTED: "Service",
  };

/** One field the request got wrong, as the validation pipe reported it. */
export interface FieldIssue {
  /** Dotted path into the request body, e.g. `name` or `thresholds.cpu`. */
  path: string;
  message: string;
}

/**
 * A request the backend refused. Everything a caller needs to decide what to do
 * next is on the instance: `status` for the branch, `issues` for a form, and
 * `message` for the backend's own words.
 *
 * Turn one into a sentence with `errorMessage()` — never render `.message`
 * straight to a person. It is written for whoever reads the logs.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly issues: FieldIssue[];
  /** The request that failed, for the console and nothing else. */
  readonly path: string;
  /**
   * The backend's name for *which* refusal this is, or `""` when it did not
   * publish one — which is almost all of them, and is why every reader has to
   * cope with the empty string rather than treat it as a bug.
   *
   * This is the field `errorMessage()` branches on before it looks at
   * `status`, and H-26 is why it exists on `ApiError` rather than only on
   * `AuthError`. A banned caller's `/servers` and `/projects` 403s carried
   * "This account is banned" in `message` and nothing else, so the console's
   * one sentence for a 403 — "Your role in this Organization does not allow
   * this" — was said to somebody whose role was fine and who could not be
   * helped by any owner changing it.
   *
   * **Rejected: matching `message`.** It is what `auth-error.ts` says was
   * removed, and it makes the backend's wire sentences load-bearing
   * — which they are not, and are not written to be (§2.5 writes them for
   * whoever reads the logs, and H-29 reworded one).
   */
  readonly code: string;
  /**
   * How many seconds a throttle said to wait, when it said. Read off
   * `Retry-After` or better-auth's `X-Retry-After` by {@link retryAfterSeconds};
   * `undefined` for every refusal that is not a 429 and for a 429 that named no
   * wait. A header rather than a body field, which is why it has to be carried
   * here explicitly: the response is gone by the time anyone renders the error.
   */
  readonly retryAfter: number | undefined;
  /**
   * Where the change is made instead, when the backend refused it because a
   * repository-kept Project config owns it; `null` for every other
   * refusal. The message already names the file and branch; this is what a
   * toast links to.
   */
  readonly pointer: ConfigPointer | null;
  /**
   * The HTTP method of the request that failed, upper-case, or `""` when the
   * error was not made from a request. A failed **read** has done
   * nothing, so `errorMessage()` must not tell its reader that part of it may
   * have happened — the sentence written for a mutation. `""` reads as a
   * mutation, which is the cautious way to be wrong.
   */
  readonly method: string;
  /**
   * The tool output a refusal carried beside its sentence, or `""`. For
   * a "Details" disclosure under the sentence, never in place of it.
   */
  readonly output: string;

  constructor(status: number, message: string, options?: {
    issues?: FieldIssue[];
    path?: string;
    code?: string;
    retryAfter?: number;
    pointer?: ConfigPointer | null;
    method?: string;
    output?: string;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.issues = options?.issues ?? [];
    this.path = options?.path ?? "";
    this.code = options?.code ?? "";
    this.retryAfter = options?.retryAfter;
    this.pointer = options?.pointer ?? null;
    this.method = options?.method?.toUpperCase() ?? "";
    this.output = options?.output ?? "";
  }

  /** A GET: the request read and changed nothing, whatever it answered. */
  get isRead(): boolean {
    return this.method === "GET";
  }

  /** The session is gone or was never there. Send them to sign in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * They are signed in and this was refused. Show it where the control is —
   * signing them out would be a lie about what went wrong.
   *
   * **Not "their role does not allow this"**, which is what this said until
   * H-26 and is what a caller reading only the status is still liable to
   * assume. A 403 is also how a **banned** account is turned down on every
   * Cloudgate route, and no role change fixes that. `code` is what tells the
   * two apart; anything rendering words off this getter alone will be wrong for
   * one of them, which is why `errorMessage()` reads the code first.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * A 403 the backend did not name — the only kind a *reader* is entitled to
   * describe in its own words (H-48, refs H-26 H-37).
   *
   * Three readers write a better sentence for a 403 than `errorMessage()` can —
   * `health-card.tsx`, `requests-chart.tsx` and `use-runtime-info.ts`'s
   * `isRefusal`, which decides five more between two modules — and they are
   * right to: they know *which* route was gated and can say "only an owner or an
   * admin can take this reading, and nothing is known to be wrong" instead of
   * the generic role line. What none of them knew is that a **banned**
   * operator's refusal has the same status, so each of them told a banned person
   * their role was the problem — H-26's defect, surviving in every place that
   * answered a 403 before `errorMessage()` was reached.
   *
   * So the guard is the code and not a list of screens. This is deliberately
   * *narrower* than "call `errorMessage()` instead": every uncoded 403 keeps the
   * bespoke sentence it has, because those sentences are better and were argued
   * for. Only a refusal the backend went to the trouble of naming is taken back
   * off them, and `errorMessage()` is where a name becomes words.
   *
   * **`code === ""` is the whole of "unnamed", and the emptiness is not
   * incidental.** `AllExceptionsFilter` puts `code` on the wire only when it is
   * a non-empty string, `client.ts` writes `""` for a body without one and
   * `AuthError` writes `""` for a failure without one, so there is no `undefined`
   * to cope with and no second spelling of absence to miss.
   *
   * **Rejected: "unnamed, or named something `AUTH_SENTENCES` has no words
   * for".** That would be the stricter guard — a code with no sentence falls
   * through `errorMessage()` to the same generic role line these screens were
   * rescued from — but it makes `lib/api` depend on `lib/auth`'s map, which is
   * the import direction `auth-error.ts` already goes the other way down. It is
   * also unreachable today: `AuthGuard` publishes `BANNED_USER` and nothing
   * else on the routes behind these five sentences, `callAuthApi`'s codes reach
   * only the routes that wrap `auth.api.*`, and every code either surface
   * publishes is in that map. A code the console cannot say anything about is a
   * promise the backend made and did not keep, and the fix belongs there.
   */
  get isUnnamedRefusal(): boolean {
    return this.isForbidden && !this.isNamed;
  }

  /**
   * The backend went to the trouble of saying *which* failure this is, so
   * `errorMessage()` has words for it and no reader should be writing its own
   * (H-48).
   *
   * The status-free half of {@link isUnnamedRefusal}, for the two cards that
   * answer **any** error with one hand-written sentence rather than branching on
   * a status: `license-status-card.tsx` and `plans-card.tsx`. Their sentences
   * are not wrong the way a status-derived one is — they say what could not be
   * read and stop — but a banned operator gets an explanation written for a
   * different fact, and in `plans-card.tsx`'s case a confident one.
   *
   * One getter rather than `error.code !== ""` at each site, because the
   * emptiness is a three-file convention (`AllExceptionsFilter` publishes no
   * empty `code`, `client.ts` and `AuthError` both write `""` for its absence)
   * and a fourth and fifth copy of the comparison is where it starts drifting.
   */
  get isNamed(): boolean {
    return this.code !== "";
  }

  /**
   * There is no such row — for this Organization. The backend answers 404 both
   * for an id that does not exist and for one that belongs to another tenant
   * (`findOne` checks `organizationId` before it returns), which is the right
   * answer to both: the second must not be distinguishable from the first.
   */
  get isMissing(): boolean {
    return this.status === 404;
  }

  /**
   * Nobody reached the machine this read is about, so nothing was read — and in
   * particular nothing is empty (X11-4).
   *
   * The status *and* the code, not the code alone: `HOST_UNREACHABLE` means one
   * thing on a 503 and nothing at all on any other status, and a getter that
   * accepted any status would be one wire change away from describing a
   * different refusal. It is the mirror of {@link isForbidden}, which reads the
   * status and lets {@link isNamed} narrow it.
   *
   * Every reader is entitled to its own sentence off this — the three cards on
   * a Server's Docker tab each say what *their* read could not do — and
   * `errorMessage()` answers for the rest, which is what stops an unrouted
   * reader announcing that the backend is down.
   *
   * **Either machine, and the union is deliberate**
   * This getter
   * answers *"nothing was read, and in particular nothing is empty"*, which is
   * true of both arms and is the only thing its five callers want to know:
   * `retryUnlessTheAnswerWillNotChange` skips the retries for either, and the
   * three cards on a Server's Docker tab read a `serverId` off a `Server` row,
   * so the platform arm cannot reach them. Narrowing it to the Server would
   * have left the retry policy needing a second predicate and, until someone
   * wrote one, given the platform arm back the two retries this policy exists
   * to remove.
   *
   * **What narrowed instead is the words**, which is where the defect was:
   * {@link isUnreachablePlatformHost} is the arm `errorMessage()` branches on
   * to pick the second sentence.
   */
  get isUnreachableHost(): boolean {
    return this.isUnreachableServer || this.isUnreachablePlatformHost;
  }

  /**
   * The Server arm alone: a machine with a `server` row, reached over SSH.
   *
   * Named rather than left as `isUnreachableHost && !isUnreachablePlatformHost`
   * so a reader that genuinely means *a Server* can say so — and so the union
   * above is visibly a union rather than one arm with a special case bolted on.
   */
  get isUnreachableServer(): boolean {
    return this.status === 503 && this.code === HOST_UNREACHABLE;
  }

  /**
   * The platform-host arm: the machine Cloudgate runs on itself, which is what
   * a docker read carrying no `serverId` addresses.
   *
   * The status *and* the code, for {@link isUnreachableHost}'s reason. See
   * {@link PLATFORM_HOST_UNREACHABLE} for why this is a code of its own rather
   * than the Server's code plus a message match or a `serverId` sniffed out of
   * {@link path}.
   */
  get isUnreachablePlatformHost(): boolean {
    return this.status === 503 && this.code === PLATFORM_HOST_UNREACHABLE;
  }

  /**
   * Templates are off on this instance. Nothing was fetched, the catalogue is
   * not empty, and asking again changes nothing until the backend is
   * restarted with other settings.
   */
  get isCatalogueNotConfigured(): boolean {
    return this.status === 503 && this.code === TEMPLATES_CATALOGUE_NOT_CONFIGURED;
  }

  /**
   * What a 403 says the caller was not given under Manage access — `"Service"`,
   * `"Environment"` or `"Project"` — or `null` for every other refusal,
   * including the role's. The status *and* the code, for
   * {@link isUnreachableHost}'s reason.
   */
  get accessNotGrantedTo(): "Project" | "Environment" | "Service" | null {
    if (this.status !== 403) return null;
    return ACCESS_NOT_GRANTED[this.code] ?? null;
  }

  /** The request body was malformed; `issues` says which fields. */
  get isValidation(): boolean {
    return this.status === 400 && this.issues.length > 0;
  }

  /** The message the validation pipe attached to one field, if any. */
  issueFor(path: string): string | undefined {
    return this.issues.find((issue) => issue.path === path)?.message;
  }
}

/**
 * The wait a throttled response asked for, in whole seconds, or `undefined`.
 *
 * Two headers, because two limiters can answer: better-auth's sends the
 * non-standard `X-Retry-After` (seconds, `dist/api/rate-limiter`), and anything
 * else — a proxy, a future Nest throttle — would send RFC 9110's `Retry-After`,
 * which is either seconds or an HTTP date. The standard one wins when both are
 * present and readable, and an unreadable one falls through to the other. When
 * neither gives a wait still to come, the answer is `undefined`: "try again in
 * 0 seconds" is not a sentence worth saying, and the caller's fallback is.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  for (const name of ["retry-after", "x-retry-after"]) {
    const value = headers.get(name)?.trim();
    if (!value) continue;
    const seconds = /^-?\d+$/.test(value)
      ? Number(value)
      : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
    // Unreadable or already over: the other header may still say something.
  }
  return undefined;
}

/**
 * The backend turned the request down (a 4xx): a fact about what was asked,
 * shown as the backend's words, not a broken request. Anything else — a 5xx,
 * a dropped connection — is ambiguous about whether it happened.
 */
export function wasRefused(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * We stopped listening, rather than being answered: the connection
 * dropped, or something in front of the backend answered for it — a proxy's
 * timeout, whose body is not `AllExceptionsFilter`'s and so carries no `path`.
 * Only then is "this may still be running" honest. Anything the backend
 * itself answered, a 5xx included, is a failure it can name, and the caller
 * shows it with `errorMessage()`.
 */
export function stoppedListening(error: unknown): boolean {
  if (isApiError(error)) return error.path === "";
  return error instanceof TypeError;
}

/** Narrowing helper — mutations and error boundaries both want it. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * {@link ApiError.isUnreachableHost} over an unknown error, which is the shape a
 * card actually holds: `UseQueryResult.error` is `Error | null`, so every reader
 * would otherwise narrow first and then ask.
 *
 * `isRefusal` in `use-runtime-info.ts` is the same convenience for the same
 * reason and is deliberately *not* generalised into this one: it is about one
 * route's 403 and reads `isUnnamedRefusal`, while this is about a named 503 on
 * any route that publishes it.
 */
export function isUnreachableHost(error: unknown): boolean {
  return isApiError(error) && error.isUnreachableHost;
}
