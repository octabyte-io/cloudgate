import { asc, eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { ipLiteral } from '../domains/ip-literal';
import { server } from '../servers/server.schema';
import { webServerSettings } from '../settings/settings.schema';

/**
 * What a Preview deployment's host is made from: the Application's
 * `previewWildcard` when it sets one, and otherwise the address of the machine
 * the preview runs on, written into an sslip.io name.
 */
export type PreviewHostRule = { wildcard: string } | { address: string };

/**
 * The rule a preview's host is made by, or `null` when there is none: no
 * wildcard, and nothing sslip.io could answer from recorded for the machine.
 *
 * **`null` is a refusal, never a fallback.** Once a missing wildcard
 * fell back to `*.sslip.io`, and `<appName>.sslip.io` has no A record — sslip.io
 * resolves only the address written into a name — so every such preview link
 * reached nothing. A value only counts as an address if it is an IP literal,
 * by the rule `DomainsService.generateDomain` applies to the same column
 * ({@link ipLiteral}); a hostname or an empty value is no address.
 *
 * Pull-request and requested previews both ask this, so the two cannot come to
 * disagree about what a preview with no wildcard gets.
 */
export function previewHostRule(
  parent: { previewWildcard: string | null },
  recordedAddress: string,
): PreviewHostRule | null {
  if (parent.previewWildcard !== null) {
    return { wildcard: parent.previewWildcard };
  }
  const address = ipLiteral(recordedAddress);
  return address === null ? null : { address };
}

/** The `-xxxxxx` `generateAppName` ends every preview's name with. */
const APP_NAME_SUFFIX_LENGTH = 7;

/** The longest a DNS label may be. */
const MAX_LABEL_LENGTH = 63;

/**
 * A preview's host by its rule: the wildcard with `*` replaced by `appName`,
 * exactly as before, or `<appName>-<address dashed>.sslip.io` — the shape
 * `DomainsService.generateDomain` gives a generated Domain, `.` and `:` both
 * becoming `-`.
 *
 * The first label must fit in 63 characters, and a dashed IPv6 address alone
 * can take 39 of them. So a name too long for what is left is cut in the
 * middle — `generateDomain` cuts the app name too — keeping the random suffix,
 * which is what makes two previews of one Application two hosts.
 */
export function previewHost(appName: string, rule: PreviewHostRule): string {
  if ('wildcard' in rule) return rule.wildcard.replace('*', appName);
  const dashed = rule.address.replaceAll('.', '-').replaceAll(':', '-');
  const budget = MAX_LABEL_LENGTH - dashed.length - 1;
  const name =
    appName.length <= budget
      ? appName
      : appName.slice(0, budget - APP_NAME_SUFFIX_LENGTH) +
        appName.slice(-APP_NAME_SUFFIX_LENGTH);
  return `${name}-${dashed}.sslip.io`;
}

/**
 * The rule a new preview of `parent` is given its host by, or `null` when it
 * could be given none that resolves. Both ways a preview is made ask
 * this — a requested preview is refused a 400 on `null`, a pull request's is
 * refused on the pull request. The machine's address is read only when there
 * is no wildcard to use instead.
 */
export async function previewHostRuleOf(
  db: DrizzleDB,
  parent: { serverId: string | null; previewWildcard: string | null },
): Promise<PreviewHostRule | null> {
  if (parent.previewWildcard !== null) {
    return { wildcard: parent.previewWildcard };
  }
  return previewHostRule(
    parent,
    await recordedPreviewAddress(db, parent.serverId),
  );
}

/**
 * What is recorded as the address of the machine a preview runs on: the run
 * Server's `ipAddress`, or on the platform host `web_server_settings.server_ip`
 * — `''` when there is none, including on an instance that has never saved its
 * settings. Unchecked: {@link previewHostRule} decides whether it is an address.
 *
 * A plain select for the settings row rather than `SettingsService`, for
 * `requestedPreviewMaxTtlMinutes`' reasons: that method writes the singleton
 * when it is missing, and this module would have to import `SettingsModule`
 * for one column.
 */
export async function recordedPreviewAddress(
  db: DrizzleDB,
  serverId: string | null,
): Promise<string> {
  if (serverId !== null) {
    const [row] = await db
      .select({ ipAddress: server.ipAddress })
      .from(server)
      .where(eq(server.serverId, serverId))
      .limit(1);
    return row?.ipAddress ?? '';
  }
  const [row] = await db
    .select({ serverIp: webServerSettings.serverIp })
    .from(webServerSettings)
    .orderBy(asc(webServerSettings.createdAt))
    .limit(1);
  return row?.serverIp ?? '';
}

/**
 * What is missing when {@link previewHostRule} has no rule, and the two ways
 * out: record an IP for the machine the preview runs on, or set a preview
 * wildcard. What `generateDomain`'s `NO_PLATFORM_ADDRESS_MESSAGE` says, plus
 * the wildcard, which a Domain has no equivalent of.
 */
export const noPreviewAddress = (serverId: string | null): string =>
  serverId === null
    ? 'no IP is recorded for this Cloudgate host: set its public address in Settings → Instance, or set a preview wildcard on the Application'
    : "no IP is recorded for the Server it runs on: set the Server's IP address, or set a preview wildcard on the Application";

/**
 * The `400` a Requested preview is refused with when {@link previewHostRule}
 * has no rule, before any row is written. One sentence, no trailing
 * period (§2.5).
 */
export const noPreviewAddressMessage = (serverId: string | null): string =>
  `A preview host carries an IP in its name when its Application sets no preview wildcard, and ${noPreviewAddress(serverId)}, then ask again`;

/**
 * What a pull request refused a preview for want of an address is told, on
 * the pull request. Written for a contributor with no console, like
 * the limit's refusal: why, and what an operator changes so the next push
 * builds one.
 */
export const noPreviewAddressRefusal =
  "This pull request was refused a preview: its Application sets no preview wildcard, so a preview host carries the IP of the machine it runs on, and no IP is recorded for that machine. Setting a preview wildcard on the Application, or recording the machine's public IP, and pushing again builds one.";
