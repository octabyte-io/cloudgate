import type { FactoryProvider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { RequestMetricsService } from '../settings/request-metrics.service';

/**
 * Whether a machine's Traefik keeps request metrics — the one question the
 * Error rate asks of `SettingsModule` (`RequestMetricsService.isEnabled`,
 * the only answer to "request metrics not enabled on this Server").
 *
 * **Resolved through `ModuleRef` rather than by importing `SettingsModule`.**
 * Importing it works — there is no cycle — but it moves `SettingsModule` ahead
 * of every Service module in Nest's initialisation order, which reorders every
 * route in the generated `openapi.json` for no change in any of them. The
 * lookup is lazy, so it runs after every module has been built.
 */
export interface RequestMetricsState {
  isEnabled(serverId: string | null): Promise<boolean>;
}

export const REQUEST_METRICS_STATE = 'REQUEST_METRICS_STATE';

export const requestMetricsStateProvider: FactoryProvider<RequestMetricsState> =
  {
    provide: REQUEST_METRICS_STATE,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): RequestMetricsState => ({
      isEnabled: (serverId) =>
        moduleRef
          .get(RequestMetricsService, { strict: false })
          .isEnabled(serverId),
    }),
  };
