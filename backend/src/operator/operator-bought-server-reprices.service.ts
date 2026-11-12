import { Injectable } from '@nestjs/common';
import { BoughtServerReprices } from '../bought-servers/bought-server-reprices.service';
import type { RepricePreview } from '../bought-servers/bought-server-reprices.service';
import type { ApplyReprice } from './dto/reprice-bought-servers.dto';
import { OperatorService } from './operator.service';
import type { OperatorCtx } from './operator.service';

/**
 * The Operator page's **reprice** (spec #1387, #1400): choose Bought
 * Servers, preview each one's old and new price, and confirm. Operators
 * only, Hosted only (`OperatorService.assertOperator`). The pricing and the
 * applying are `BoughtServerReprices`'; this checks the caller and audits.
 *
 * Its own service beside `OperatorBoughtServers`, which the other Operator
 * actions on Bought Servers grow.
 */
@Injectable()
export class OperatorBoughtServerReprices {
  constructor(
    private readonly operator: OperatorService,
    private readonly reprices: BoughtServerReprices,
  ) {}

  /** Each chosen Bought Server's old price and its price at today's list and markup. */
  async preview(ctx: OperatorCtx, ids: string[]): Promise<RepricePreview[]> {
    await this.operator.assertOperator(ctx);
    return this.reprices.preview(ids);
  }

  /**
   * Applies the previewed reprice, then records it in each Organization's
   * log and the Instance organization's, through the Operator write path:
   * one row per Organization, naming each Server, its old and new price and
   * the day the new one starts.
   */
  async apply(ctx: OperatorCtx, body: ApplyReprice): Promise<RepricePreview[]> {
    await this.operator.assertOperator(ctx);
    const applied = await this.reprices.apply(body.servers);

    const byOrganization = new Map<string, RepricePreview[]>();
    for (const preview of applied) {
      const servers = byOrganization.get(preview.organization.id) ?? [];
      servers.push(preview);
      byOrganization.set(preview.organization.id, servers);
    }
    for (const [organizationId, servers] of byOrganization) {
      await this.operator.recordWrite(
        ctx,
        await this.operator.targetOf(organizationId),
        {
          type: 'repriceBoughtServers',
          servers: servers.map((server) => ({
            id: server.id,
            name: server.name,
            fromMonthlyCents: server.oldMonthlyCents,
            toMonthlyCents: server.newMonthlyCents,
            startsAt: server.startsAt?.toISOString(),
          })),
        },
      );
    }
    return applied;
  }
}
