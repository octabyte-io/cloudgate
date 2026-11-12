import type { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';

import type { DrizzleDB } from '../../src/db/drizzle.module';
import { webServerSettings } from '../../src/db/schema';
import { DomainsService } from '../../src/domains/domains.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import { server } from '../../src/servers/server.schema';
import {
  previewHost,
  previewHostRule,
  recordedPreviewAddress,
} from '../../src/preview-deployments/preview-host';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';

/**
 * Which address a generated `sslip.io` host carries, and that every reader of
 * `web_server_settings.server_ip` that writes one into a host gives the same
 * answer: the domains dialog's `DomainsService.generateDomain` and a Preview
 * deployment's host when its Application sets no wildcard. Both go through
 * `ipLiteral`; the `template.toml` reader kept a copy of it until that reader
 * was removed (ADR-0066).
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/**
 * What the settings singleton holds: an address, an empty column, or no row at
 * all — the third being an instance that has never saved its settings.
 */
type Recorded = string | null;

/**
 * The settings singleton of an instance that has never saved one — told apart
 * from an empty column, because they are two different rows to have and the
 * same answer to give.
 */
const NO_SETTINGS_ROW = 'no-settings-row';

/** The settings singleton as the two `db`-reading paths see it. */
function settingsDb(recorded: Recorded): DrizzleDB {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === server) return [];
    if (table === webServerSettings) {
      return recorded === NO_SETTINGS_ROW ? [] : [{ serverIp: recorded }];
    }
    throw new Error('unexpected table read');
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
        };
        return chain;
      },
    }),
  } as unknown as DrizzleDB;
}

/** The domains dialog's own reader of the column. */
function domainsService(recorded: Recorded): DomainsService {
  return new DomainsService(
    settingsDb(recorded),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {
      regenerate: jest.fn().mockResolvedValue(undefined),
    } as unknown as TraefikAppConfigService,
    // Reached only by a Domain on a Service in a Cloud account.
    {} as ModuleRef,
  );
}

/**
 * The second reader: a Preview deployment on the platform host whose
 * Application sets no preview wildcard. It refuses where there is no address,
 * so `null` here stands for that refusal.
 */
async function previewHostOf(recorded: Recorded): Promise<string | null> {
  const rule = previewHostRule(
    { previewWildcard: null },
    await recordedPreviewAddress(settingsDb(recorded), null),
  );
  return rule === null ? null : previewHost('preview-blog-abc123', rule);
}

/**
 * The address segment a generated `<stem>-<hash>[-<address>].sslip.io` carries,
 * or `null` when it carries none. Written against the shape rather than
 * against a particular address so the two paths can be compared by it.
 */
function addressSegment(host: string): string | null {
  const matched = /-[0-9a-f]{6}-(.+)\.sslip\.io$/.exec(host);
  return matched ? matched[1] : null;
}

/**
 * The census: one column, every reader of it that writes an address into a
 * host, and no second answer between them. What must not differ is the
 * *question*: is there an address sslip.io can answer from? A row that makes
 * one of them mint `-127-0-0-1` while the other refuses is the drift this
 * table exists to catch.
 */
describe('ipLiteral', () => {
  const cases: { what: string; recorded: Recorded; address: string | null }[] =
    [
      {
        what: 'a recorded IPv4 address',
        recorded: '198.51.100.7',
        address: '198-51-100-7',
      },
      {
        what: 'a recorded IPv6 address',
        recorded: '2001:db8::1',
        address: '2001-db8--1',
      },
      { what: 'an empty column', recorded: null, address: null },
      {
        what: 'no settings row at all',
        recorded: NO_SETTINGS_ROW,
        address: null,
      },
      {
        what: 'a hostname where an address is needed',
        recorded: 'console.example.com',
        address: null,
      },
    ];

  it.each(cases)(
    'writes $address into every generated host, for $what',
    async ({ recorded, address }) => {
      let domains: string | null;
      try {
        domains = addressSegment(
          await domainsService(recorded).generateDomain(ctx, 'blog', null),
        );
      } catch (error) {
        // The domains dialog's shape for "there is no address": it refuses,
        // and the refusal names the screen that fixes it.
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toMatch(
          /Settings → Instance/,
        );
        domains = null;
      }

      const previewHostName = await previewHostOf(recorded);
      const previews =
        previewHostName === null ? null : addressSegment(previewHostName);

      expect({ domains, previews }).toEqual({
        domains: address,
        previews: address,
      });
    },
  );
});
