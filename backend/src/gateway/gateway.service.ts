import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { aiModelFacet } from '../ai-models/ai-model.schema';
import type { InferenceRuntime } from '../ai-models/ai-model.schema';
import { INFERENCE_RUNTIMES } from '../ai-models/inference-runtime';
import { application } from '../applications/application.schema';
import { user } from '../auth/auth.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { deployment } from '../deployments/deployment.schema';
import { environment } from '../environments/environment.schema';
import type { AgentCaller } from '../mcp/mcp-authenticator';
import { McpAuthenticator } from '../mcp/mcp-authenticator';
import { project } from '../projects/project.schema';
import { PermissionService } from '../rbac/permission.service';
import { server } from '../servers/server.schema';
import { ServerAddressGuard } from '../servers/server-address-guard';
import { aiUsage } from './ai-usage.schema';
import type { AiUsageOutcome } from './ai-usage.schema';
import {
  AI_MODEL_NOT_FOUND,
  KEY_REFUSED,
  NOT_ANSWERING,
  NOT_FORWARDED,
  NOT_RUNNING,
  sendRefusal,
  wrongModel,
} from './gateway-refusals';
import type { GatewayRefusal } from './gateway-refusals';
import { gatewayBodyRefusal } from './gateway-body';
import { UPSTREAM_SECRET_HEADER, upstreamPathPrefix } from './gateway-route';
import {
  NO_TOKENS,
  StreamMeter,
  tokensOfWhole,
  withStreamedUsage,
} from './stream-meter';
import type { Tokens } from './stream-meter';
import { AiModelNotAnsweringEpisodes } from './not-answering-episodes';

/**
 * The port the Gateway dials each machine's Traefik on: its `web` entry
 * point, `TRAEFIK_PORT` on every machine Cloudgate sets up. A token so a test
 * reaches its stub upstream the way the Gateway reaches a Server's Traefik,
 * by the configured address, with no new port on the Gateway.
 */
export const GATEWAY_TRAEFIK_PORT = Symbol('GATEWAY_TRAEFIK_PORT');

/** The platform host's Traefik, as this host process reaches it. */
const PLATFORM_HOST_TRAEFIK = '127.0.0.1';

/**
 * The four calls the Gateway forwards, by endpoint, and the one method each
 * takes. Anything else, `/api/*` included, is refused 404.
 */
const FORWARDED: Readonly<Record<string, 'GET' | 'POST'>> = {
  '/v1/chat/completions': 'POST',
  '/v1/completions': 'POST',
  '/v1/embeddings': 'POST',
  '/v1/models': 'GET',
};

/** Longest endpoint a usage row keeps; a row is a record, not a payload. */
const MAX_ENDPOINT = 200;

/** One AI model, as a call to it needs it. The upstream secret included. */
interface AiModelTarget {
  applicationId: string;
  appName: string;
  applicationStatus: string;
  serverId: string | null;
  serverIp: string | null;
  /** The model served: the last one a Deployment had ready, else the facet's. */
  model: string;
  runtime: InferenceRuntime;
  upstreamSecret: string;
}

/** One call, once it is known to be an authenticated Agent's. */
interface Call {
  agent: AgentCaller;
  agentName: string;
  target: AiModelTarget;
  endpoint: string;
  streamed: boolean;
  startedAt: Date;
}

/**
 * The **Gateway** (`CONTEXT.md`, the gateway ADR): the only way into an AI
 * model and the only meter, in-process.
 *
 * In order, for every call to `/ai/<applicationId>/*`:
 *
 * 1. **The key** (`McpAuthenticator`, as at `/mcp`): anything but an Agent
 *    key in force — unknown, revoked, expired, suspended or a person's — is
 *    refused 401 "Key refused" and **writes nothing**.
 * 2. **The AI model and the one check** (ADR-0023's fourth entry point):
 *    `checkServiceAccess(…, 'call')`, which is `checkPermission` for
 *    `service: ['call']` plus the Agent's grant. A missing or foreign AI
 *    model is 404 with no row (a row needs the AI model); one this Agent may
 *    not call is the same 404 and writes a `refused` row.
 * 3. **The body** (413 over 16 MiB, 400 when not JSON; `gateway-body.ts`),
 *    **the allowlist** (404), **the model hold** (400) and **running** (503),
 *    each writing a `refused` row with zero tokens; the runtime never sees
 *    them.
 * 4. **The hop**, through the AI model's machine's Traefik with the upstream
 *    secret (`gateway-route.ts`), and one usage row when the call settles.
 *
 * No deadline and no rate limit. No audit row: the usage row is the record.
 */
/**
 * Whether a body's `model` names the model served: as the facet spells it, or
 * as the runtime's own listing does. `GET /v1/models` answers with the
 * runtime's spelling, so Ollama names a facet's `all-minilm` as
 * `all-minilm:latest`, and a client that sends back the id it was given is
 * asking for the model served (found on a live walk). The name is still
 * forwarded as the caller wrote it, never rewritten.
 */
function namesServedModel(model: unknown, target: AiModelTarget): boolean {
  if (typeof model !== 'string') return false;
  return (
    model === target.model ||
    INFERENCE_RUNTIMES[target.runtime].isServedModel(model, target.model)
  );
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly authenticator: McpAuthenticator,
    private readonly permissions: PermissionService,
    @Inject(GATEWAY_TRAEFIK_PORT) private readonly traefikPort: number,
    private readonly notAnswering: AiModelNotAnsweringEpisodes,
    private readonly serverAddresses: ServerAddressGuard,
  ) {}

  async handle(
    req: Request,
    res: Response,
    applicationId: string,
    rest: string[] | string,
  ): Promise<void> {
    const startedAt = new Date();
    const authentication = await this.authenticator.authenticate(
      req.headers.authorization,
    );
    if (authentication.kind !== 'agent' || authentication.agent.suspended) {
      sendRefusal(res, KEY_REFUSED);
      return;
    }
    const agent = authentication.agent;

    const target = await this.findAiModel(applicationId, agent.organizationId);
    if (!target) {
      sendRefusal(res, AI_MODEL_NOT_FOUND);
      return;
    }

    const body = isRecord(req.body) ? req.body : {};
    const call: Call = {
      agent,
      agentName: await this.agentName(agent.userId),
      target,
      endpoint: endpointOf(rest),
      streamed: body.stream === true,
      startedAt,
    };

    try {
      await this.permissions.checkServiceAccess(
        agent.ctx,
        applicationId,
        'call',
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return this.refuse(res, call, AI_MODEL_NOT_FOUND);
    }

    const bodyRefusal = gatewayBodyRefusal(req);
    if (bodyRefusal) return this.refuse(res, call, bodyRefusal);
    if (FORWARDED[call.endpoint] !== req.method) {
      return this.refuse(res, call, NOT_FORWARDED);
    }
    if (req.method === 'POST' && !namesServedModel(body.model, target)) {
      return this.refuse(res, call, wrongModel(target.model));
    }
    if (
      target.applicationStatus === 'stopped' ||
      target.applicationStatus === 'idle'
    ) {
      return this.refuse(res, call, NOT_RUNNING);
    }

    // The Server's stored address is checked at every call, as at every SSH
    // connect (ADR-0053), and the address checked is the one dialled: a
    // hostname repointed at the platform host, a private range or the cloud
    // metadata address after it was saved is refused here, not forwarded to.
    let dialHost = PLATFORM_HOST_TRAEFIK;
    if (target.serverIp !== null) {
      try {
        dialHost = await this.serverAddresses.addressToDial(target.serverIp);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return this.refuse(res, call, NOT_ANSWERING);
      }
    }

    return this.forward(req, res, call, body, dialHost);
  }

  private async refuse(
    res: Response,
    call: Call,
    refusal: GatewayRefusal,
  ): Promise<void> {
    // The row first, then the answer: a caller who has the refusal can count
    // on its row being there.
    await this.record(call, 'refused', NO_TOKENS);
    sendRefusal(res, refusal);
  }

  /**
   * Sends the call to the runtime through its machine's Traefik and answers
   * with what the runtime said, writing the row once the call settles: when
   * the answer is whole (written just before it is sent), when the runtime
   * could not be reached or broke off, or when the caller went away first.
   * Whichever happens first is the outcome; the row is written exactly once.
   *
   * A non-streamed answer is read whole, for its `usage`, and then sent.
   *
   * A stream is piped with `stream.pipeline` for backpressure, through
   * a {@link StreamMeter}, with no deadline:
   *
   * - `stream_options.include_usage` is forced on upstream, and the usage
   *   chunk handed on only to a caller who asked for it;
   * - usage that never arrives is estimated with a tokenizer and flagged so;
   * - a caller who leaves aborts the runtime's request and writes a
   *   `client-aborted` row; a runtime that breaks off writes `runtime-error`.
   *
   * The key was checked once, at the start: a revoke while a stream runs
   * refuses the next call and lets this one finish and write its row.
   */
  private forward(
    req: Request,
    res: Response,
    call: Call,
    body: Record<string, unknown>,
    dialHost: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      /**
       * Writes the row once, then does `then` — the end of a whole answer or
       * a refusal — so the row exists by the time the caller has the answer.
       */
      const settle = (
        outcome: AiUsageOutcome,
        tokens: Tokens,
        then: () => void = () => undefined,
      ) => {
        if (settled) return;
        settled = true;
        this.record(call, outcome, tokens)
          .catch((error: unknown) =>
            this.logger.error(
              `Usage row for a call to ${call.target.appName} was not written: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          )
          .finally(() => {
            then();
            resolve();
          });
      };

      const { upstreamBody, callerAskedForUsage } = call.streamed
        ? withStreamedUsage(call.endpoint, body)
        : { upstreamBody: body, callerAskedForUsage: true };
      const meter = call.streamed
        ? new StreamMeter(body, callerAskedForUsage)
        : null;
      /** What the call has spent by now; a whole answer's are counted on arrival. */
      const spentSoFar = (): Tokens => (meter ? meter.tokens() : NO_TOKENS);

      const payload =
        req.method === 'POST'
          ? Buffer.from(JSON.stringify(upstreamBody))
          : undefined;
      const query = req.url.includes('?')
        ? req.url.slice(req.url.indexOf('?'))
        : '';
      const upstream = httpRequest({
        host: dialHost,
        port: this.traefikPort,
        method: req.method,
        path: `${upstreamPathPrefix(call.target.applicationId)}${call.endpoint}${query}`,
        headers: {
          [UPSTREAM_SECRET_HEADER]: call.target.upstreamSecret,
          accept: req.headers.accept ?? 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': payload.length,
              }
            : {}),
        },
      });

      // The caller went away before the answer was whole: the runtime's work
      // is abandoned with it, and the row still written. Registered before
      // the pipeline, so a caller's leaving is seen as that, not as the
      // runtime breaking off when the pipeline tears the answer down after.
      res.on('close', () => {
        if (res.writableFinished) return;
        if (!upstream.destroyed) upstream.destroy();
        settle('client-aborted', spentSoFar());
      });

      // Unreachable, or cut before its answer began. A call already settled
      // (answered, or left by its caller) keeps its row.
      upstream.on('error', () => {
        if (settled) return;
        settle('runtime-error', spentSoFar(), () => {
          if (!res.headersSent) sendRefusal(res, NOT_ANSWERING);
          else res.destroy();
        });
      });

      upstream.on('response', (answer) => {
        // The machine's Traefik answering for a runtime it could not reach:
        // its own plain `404 page not found` once the runtime's router is
        // gone (a task down, a redeploy's stop-first gap), or its 502/503.
        // The runtime was never reached, so this is the runtime's failure,
        // not an answer to hand on, and the caller is told so in OpenAI's
        // shape like every other refusal (spec story 59).
        if (!fromRuntime(answer)) {
          answer.resume();
          settle('runtime-error', NO_TOKENS, () =>
            sendRefusal(res, NOT_ANSWERING),
          );
          return;
        }
        const outcome: AiUsageOutcome =
          (answer.statusCode ?? 502) >= 500 ? 'runtime-error' : 'ok';
        res.status(answer.statusCode ?? 502);
        for (const name of ['content-type', 'cache-control']) {
          const value = answer.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        if (meter && isEventStream(answer)) {
          // Nothing between here and the caller may hold events back.
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-accel-buffering', 'no');
          res.flushHeaders();
          // The runtime broke off mid-stream. Registered before the
          // pipeline's own teardown, so it is not mistaken for the caller
          // leaving when the pipeline then destroys the response.
          answer.on('error', () => settle('runtime-error', meter.tokens()));
          // Whatever else broke the pipeline is the runtime's side too; a
          // call already settled by either listener above keeps its row.
          pipeline(answer, meter, res, (error) => {
            settle(error ? 'runtime-error' : outcome, meter.tokens());
          });
          return;
        }
        readWhole(answer, (error, whole) => {
          if (error) {
            settle('runtime-error', spentSoFar(), () => {
              if (!res.headersSent) sendRefusal(res, NOT_ANSWERING);
              else res.destroy();
            });
            return;
          }
          // An answer that is not a 2xx is an error, which spends nothing.
          const status = answer.statusCode ?? 502;
          const tokens =
            status >= 200 && status < 300
              ? tokensOfWhole(call.endpoint, body, whole)
              : NO_TOKENS;
          settle(outcome, tokens, () => res.end(whole));
        });
      });

      upstream.end(payload);
    });
  }

  private async record(
    call: Call,
    outcome: AiUsageOutcome,
    tokens: Tokens,
  ): Promise<void> {
    // Every settled call, by the outcome its row keeps — except a
    // failure while a Deployment of the AI model is releasing: a redeploy
    // the operator started takes the runtime away on purpose (stop-first
    // with a GPU), and that is no outage to page about (story 98).
    if (
      outcome !== 'runtime-error' ||
      !(await this.deploying(call.target.applicationId))
    ) {
      this.notAnswering.observe(call.target.applicationId, outcome, new Date());
    }
    await this.db.insert(aiUsage).values({
      applicationId: call.target.applicationId,
      agentUserId: call.agent.userId,
      agentName: call.agentName,
      agentId: call.agent.userId,
      apikeyId: call.agent.key.id,
      model: call.target.model,
      endpoint: call.endpoint.slice(0, MAX_ENDPOINT),
      streamed: call.streamed,
      promptTokens: tokens.prompt,
      promptTokensEstimated: tokens.promptEstimated,
      completionTokens: tokens.completion,
      completionTokensEstimated: tokens.completionEstimated,
      startedAt: call.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      outcome,
    });
  }

  /**
   * The AI model `applicationId`, if it is one and in `organizationId`; a
   * plain Application, a deleted one and another Organization's are all
   * `null`, which is the same 404.
   */
  private async findAiModel(
    applicationId: string,
    organizationId: string,
  ): Promise<AiModelTarget | null> {
    const [row] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        applicationStatus: application.applicationStatus,
        serverId: application.serverId,
        serverIp: server.ipAddress,
        // The model the running version serves, not an edit saved since and
        // not yet deployed (the spec: it "takes effect on the next deploy").
        model: sql<string>`coalesce(${aiModelFacet.servedModel}, ${aiModelFacet.model})`,
        runtime: aiModelFacet.runtime,
        upstreamSecret: aiModelFacet.upstreamSecret,
      })
      .from(application)
      .innerJoin(
        aiModelFacet,
        eq(aiModelFacet.applicationId, application.applicationId),
      )
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .leftJoin(server, eq(server.serverId, application.serverId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Whether a Deployment of `applicationId` is running now. */
  private async deploying(applicationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ deploymentId: deployment.deploymentId })
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          isNull(deployment.previewDeploymentId),
          eq(deployment.status, 'running'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The Agent's name as its row keeps it, past the Agent's removal. */
  private async agentName(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: user.firstName })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.name ?? '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path under the AI model, from the route's wildcard (Express 5 hands it as segments). */
function endpointOf(rest: string[] | string): string {
  return `/${Array.isArray(rest) ? rest.join('/') : rest}`;
}

function readWhole(
  answer: IncomingMessage,
  done: (error: Error | null, whole: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  answer.on('data', (chunk: Buffer) => chunks.push(chunk));
  answer.on('end', () => done(null, Buffer.concat(chunks)));
  answer.on('error', (error) => done(error, Buffer.alloc(0)));
}

/**
 * Whether `answer` is the runtime's own, rather than the machine's Traefik
 * answering in its place: a success, or an error in the JSON every supported
 * runtime speaks. Traefik's own refusals are `text/plain`.
 */
function fromRuntime(answer: IncomingMessage): boolean {
  if ((answer.statusCode ?? 502) < 400) return true;
  const type = String(answer.headers['content-type'] ?? '');
  return type.includes('json') || type.startsWith('text/event-stream');
}

/** Whether the runtime answered as a stream of server-sent events. */
function isEventStream(answer: IncomingMessage): boolean {
  return String(answer.headers['content-type'] ?? '').startsWith(
    'text/event-stream',
  );
}
