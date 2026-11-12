import { All, Controller, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { McpDispatcher } from './mcp-dispatcher';
import type { McpHttpResponse } from './mcp-protocol';

/**
 * `POST /mcp`, the MCP endpoint (ADR-0025), reached from the console's
 * origin through one Next rewrite.
 *
 * `@Public()` because the dispatcher authenticates the Agent key itself:
 * `AuthGuard` reads cookies and `x-api-key`, would answer a Bearer key with a
 * bare 401 and no `WWW-Authenticate`, and refuses an Agent everywhere by
 * design. Being public also keeps `AuditInterceptor` off the route — it has no
 * `request.user` to record — which is right, because the dispatcher writes one
 * row per tool call itself (`POST /mcp` is in `NOT_RECORDED_ROUTES`).
 *
 * The response is written here rather than returned, so `AllExceptionsFilter`
 * never reshapes a JSON-RPC body, a 401's `WWW-Authenticate` or a 405's `Allow`.
 * Not in the OpenAPI document: this is not a REST route.
 */
@Public()
@ApiExcludeController()
@Controller('mcp')
export class McpController {
  constructor(private readonly dispatcher: McpDispatcher) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    send(res, await this.dispatcher.handle(from(req)));
  }

  /** GET and DELETE are 2025 session operations; the endpoint keeps no session (405). */
  @All()
  refuse(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handle(req, res);
  }
}

function from(req: Request) {
  return {
    method: req.method,
    headers: req.headers,
    body: req.body as unknown,
    ip: req.ip,
  };
}

function send(res: Response, answer: McpHttpResponse): void {
  res.status(answer.status);
  for (const [name, value] of Object.entries(answer.headers)) {
    res.setHeader(name, value);
  }
  res.send(answer.body);
}
