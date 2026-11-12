/**
 * The settings that name this Instance's own public origins: the console's
 * (`SITE_URL`, which the Hosted instance cannot boot without, and
 * `BETTER_AUTH_URL`) and the API's (`CLOUDGATE_API_URL`).
 *
 * On the Hosted instance all three are `https://<CLOUDGATE_HOSTNAME>`: the
 * install writes them from that one input (`deploy/install.sh`'s
 * `CONSOLE_ORIGIN` and `API_ORIGIN`, `deploy/hosted.sh`'s `SITE_URL`) and
 * routes it in `dynamic/hosted.yml`, a file no `webServerSettings` column
 * describes. So these, and not Settings > Web server's `host`, are what names
 * that hostname to the backend.
 */
export const INSTANCE_ORIGIN_SETTINGS = [
  'SITE_URL',
  'BETTER_AUTH_URL',
  'CLOUDGATE_API_URL',
] as const;

/** What {@link instanceOwnHosts} reads a setting through. */
export type InstanceOriginReader = (
  name: (typeof INSTANCE_ORIGIN_SETTINGS)[number],
) => string | undefined | null;

/**
 * The hostnames this Instance answers on itself, lower-cased, from
 * {@link INSTANCE_ORIGIN_SETTINGS}. A setting that is unset or is not a URL
 * names nothing.
 */
export function instanceOwnHosts(read: InstanceOriginReader): string[] {
  const hosts = new Set<string>();
  for (const name of INSTANCE_ORIGIN_SETTINGS) {
    const value = read(name)?.trim();
    if (!value) continue;
    let hostname: string;
    try {
      hostname = new URL(value).hostname;
    } catch {
      continue;
    }
    const bare = hostname
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/\.$/, '')
      .toLowerCase();
    if (bare !== '') hosts.add(bare);
  }
  return [...hosts];
}
