import { All, Controller, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { GatewayService } from './gateway.service';

/**
 * `/ai/<AI model's Application id>/*`, the **Gateway** (the gateway
 * ADR). `<…>/v1` is the base URL any OpenAI client is given; every other path
 * under the AI model, `/api/*` included, is caught here too so the Gateway can
 * refuse it, OpenAI-shaped and with a usage row.
 *
 * `@Public()` because the Agent key is its only guard and `GatewayService`
 * checks it, as `McpController` does: `AuthGuard` reads cookies and
 * `x-api-key` and refuses an Agent everywhere by design. Being public also
 * keeps `AuditInterceptor` off it, which is right: a call writes a usage row
 * and never an audit row.
 *
 * **No `@Controller('ai')`**: that prefix is `AiController`'s, Cloudgate's own
 * AI provider (`/ai`, `/ai/:id`, …). This route needs a third segment, which
 * only one of those has: `POST /ai/:id/test-connection`. `AiModule` is
 * imported before `GatewayModule`, so Express matches that one route to
 * `AiController` first, as before; any other method or path under an id is
 * the Gateway's.
 *
 * The response is written here rather than returned, so `AllExceptionsFilter`
 * never reshapes an OpenAI-shaped refusal or the runtime's own answer. Not in
 * the OpenAPI document: this is not a REST route.
 */
@Public()
@ApiExcludeController()
@Controller()
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @All('ai/:applicationId/*rest')
  handle(
    @Param('applicationId') applicationId: string,
    @Param('rest') rest: string[] | string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.gateway.handle(req, res, applicationId, rest);
  }
}
