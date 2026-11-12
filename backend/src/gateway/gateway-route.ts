import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { quote } from 'shell-quote';
import { stringify } from 'yaml';
import { aiModelFacet } from '../ai-models/ai-model.schema';
import { INFERENCE_RUNTIMES } from '../ai-models/inference-runtime';
import type { TeardownStep } from '../common/teardown-steps';
import {
  replaceOwnerOnlyFileCommand,
  replaceOwnerOnlyFileSync,
} from '../common/files/owner-only';
import type { DrizzleDB } from '../db/drizzle.module';
import type { RemoteExecService } from '../remote/remote-exec.service';
import type { FileConfig } from '../traefik/config/file-types';
import {
  dynamicTraefikConfigPath,
  dynamicTraefikDirectory,
} from '../traefik/traefik-writer.service';

/**
 * The header the Gateway presents its per-AI-model upstream secret in, and the
 * only thing the gateway-only router on the AI model's machine matches besides
 * its path (the gateway ADR). The router strips it before the runtime
 * sees the request.
 */
export const UPSTREAM_SECRET_HEADER = 'X-Cloudgate-Upstream';

/**
 * The path every hop to one AI model starts with on its machine's Traefik:
 * `/cloudgate-gateway/<applicationId>`, stripped before the runtime sees it.
 * The id rather than the `appName`, as in the public endpoint.
 */
export const upstreamPathPrefix = (applicationId: string): string =>
  `/cloudgate-gateway/${applicationId}`;

/**
 * Where an AI model's gateway-only router lives on its run machine:
 * `dynamic/ai-gateway+<appName>.yml`.
 *
 * **Not `dynamic/<appName>.yml`**, because that file is
 * `TraefikAppConfigService.regenerate`'s, rewritten whole from the Domain rows
 * (and removed when there are none), and an AI model has no Domain; and not a
 * name like `<appName>-gateway.yml`, which an Application named
 * `<appName>-gateway` would own. `+` is outside `APP_NAME_REGEX`, so no
 * Application's file can be named this, as with a stack's `compose+<appName>`
 * (`traefik/config/names.ts`).
 *
 * **At the top of `dynamic/`, not in a directory of its own.** It was
 * `dynamic/ai-gateway/<appName>.yml` until a live walk found a new AI model
 * unreachable (`502 model_not_answering`, Traefik's 404) until an unrelated
 * top-level file changed. `traefik:v3.6.7`'s file provider loads the tree under
 * `dynamic/` at each reload but puts its watch on `dynamic/` alone ("ignore
 * sub-dir", `pkg/provider/file/file.go`), so a file written in a subdirectory
 * raises no reload. That old path is {@link legacyGatewayRouteConfigPath}.
 */
export const gatewayRouteConfigPath = (
  appName: string,
  serverId: string | null,
): string => dynamicTraefikConfigPath(`ai-gateway+${appName}`, serverId);

/**
 * Where an earlier version wrote the router, `dynamic/ai-gateway/<appName>.yml`,
 * which Traefik reads at a reload but never reloads for. A deploy
 * removes it before writing {@link gatewayRouteConfigPath}, and a Delete removes
 * both, so a Server an earlier version deployed to is corrected by the next
 * deploy or Delete of each AI model. Removed *before* the new file is written,
 * not after: the two define the same routers, Traefik keeps the first it reads
 * (`ai-gateway/` sorts ahead of `ai-gateway+…`), and a removal in the
 * subdirectory raises no reload to correct that.
 */
export const legacyGatewayRouteConfigPath = (
  appName: string,
  serverId: string | null,
): string =>
  path.join(dynamicTraefikDirectory(serverId), 'ai-gateway', `${appName}.yml`);

/** The router's names, all prefixed by the `appName` like every other. */
const names = (appName: string) => ({
  router: `${appName}-gateway-router`,
  service: `${appName}-gateway-service`,
  strip: `${appName}-gateway-strip`,
  unsecret: `${appName}-gateway-unsecret`,
});

/**
 * The gateway-only router for one AI model: on the machine's
 * `web` entry point, matching only {@link upstreamPathPrefix} **and** the
 * upstream secret in {@link UPSTREAM_SECRET_HEADER}, and sending the call to
 * the runtime by its name on `cloudgate-ai`. Two middlewares: one strips the
 * prefix, one removes the secret, so the runtime sees `/v1/...` and nothing of
 * the hop. Without the secret nothing matches and Traefik answers its own 404,
 * so the runtime has no public route of its own.
 */
export function gatewayRouteConfig(target: {
  applicationId: string;
  appName: string;
  port: number;
  upstreamSecret: string;
}): FileConfig {
  const name = names(target.appName);
  const prefix = upstreamPathPrefix(target.applicationId);
  return {
    http: {
      routers: {
        [name.router]: {
          rule: `PathPrefix(\`${prefix}/\`) && Header(\`${UPSTREAM_SECRET_HEADER}\`, \`${target.upstreamSecret}\`)`,
          service: name.service,
          entryPoints: ['web'],
          middlewares: [name.strip, name.unsecret],
        },
      },
      middlewares: {
        [name.strip]: { stripPrefix: { prefixes: [prefix] } },
        [name.unsecret]: {
          headers: { customRequestHeaders: { [UPSTREAM_SECRET_HEADER]: '' } },
        },
      },
      services: {
        [name.service]: {
          loadBalancer: {
            servers: [{ url: `http://${target.appName}:${target.port}` }],
          },
        },
      },
    },
  };
}

/**
 * Writes the AI model's gateway-only router on its run machine, at every
 * deploy, so a deploy is also what puts a lost file back. The file
 * carries the upstream secret in plaintext, because Traefik has to read it,
 * so it is `0600`, as a certificate's key is; but in `dynamic/` itself,
 * which stays open, so it is renamed into place from a file created `0600`
 * rather than tightened in a closed directory (`replaceOwnerOnlyFile*`). The
 * rename is the event Traefik's watch reloads on. An earlier version's
 * {@link legacyGatewayRouteConfigPath} goes first, and its directory with it
 * once empty.
 *
 * This is the one read of the upstream secret besides the Gateway's own call
 * path (`ai-model.schema.ts`).
 */
export async function writeGatewayRoute(
  db: DrizzleDB,
  remoteExec: RemoteExecService,
  target: { applicationId: string; appName: string; serverId: string | null },
): Promise<void> {
  const [facet] = await db
    .select({
      runtime: aiModelFacet.runtime,
      upstreamSecret: aiModelFacet.upstreamSecret,
    })
    .from(aiModelFacet)
    .where(eq(aiModelFacet.applicationId, target.applicationId))
    .limit(1);
  if (!facet) return;
  const content = stringify(
    gatewayRouteConfig({
      applicationId: target.applicationId,
      appName: target.appName,
      port: INFERENCE_RUNTIMES[facet.runtime].port,
      upstreamSecret: facet.upstreamSecret,
    }),
  );
  const file = gatewayRouteConfigPath(target.appName, target.serverId);
  const legacy = legacyGatewayRouteConfigPath(target.appName, target.serverId);
  if (target.serverId) {
    await remoteExec.execAsyncRemote(
      target.serverId,
      [
        `rm -f ${quote([legacy])}`,
        `{ rmdir ${quote([path.dirname(legacy)])} 2>/dev/null || true; }`,
        replaceOwnerOnlyFileCommand(file, content),
      ].join(' && '),
    );
    return;
  }
  fs.rmSync(legacy, { force: true });
  try {
    fs.rmdirSync(path.dirname(legacy));
  } catch {
    // Absent, or still holding another AI model's file: either is fine.
  }
  replaceOwnerOnlyFileSync(file, content);
}

/**
 * Removing an AI model's gateway-only router, as the teardown step a Delete
 * reports on when it fails: a router left behind routes at nothing,
 * but it is a live Traefik fragment on the run machine, which is
 * `'traefik-config'`'s meaning (`common/teardown-steps.ts`). A Delete passes
 * its `ReachabilityMemo` as `remoteExec`, so an unreachable Server is not
 * dialled again. It removes an earlier version's
 * {@link legacyGatewayRouteConfigPath} too, which a model never redeployed
 * since still has; the report names the current path.
 */
export const removeGatewayRouteStep = (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
): TeardownStep => {
  const file = gatewayRouteConfigPath(appName, serverId);
  const legacy = legacyGatewayRouteConfigPath(appName, serverId);
  return {
    run: async () => {
      if (serverId) {
        await remoteExec.execRemote(serverId, ['rm', '-f', file, legacy]);
        return;
      }
      fs.rmSync(file, { force: true });
      fs.rmSync(legacy, { force: true });
    },
    leftBehindOnFailure: {
      kind: 'traefik-config',
      appName,
      serverId,
      path: file,
    },
  };
};
