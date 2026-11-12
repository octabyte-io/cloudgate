import { posix, win32 } from 'node:path';

/**
 * The folder the CLI keeps its settings in (CLI spec, Choosing an Instance):
 * `CLOUDGATE_CONFIG_DIR` when set; otherwise `%APPDATA%\cloudgate\` on Windows
 * and `$XDG_CONFIG_HOME/cloudgate/` (default `~/.config/cloudgate/`) on Linux
 * and macOS. An empty variable counts as unset, and a relative
 * `XDG_CONFIG_HOME` is ignored, as the XDG Base Directory spec says.
 *
 * Only decides the path; nothing is created until something is written there.
 */
export function configDir(facts: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
}): string {
  const { env, platform, homedir } = facts;
  if (env.CLOUDGATE_CONFIG_DIR) return env.CLOUDGATE_CONFIG_DIR;
  if (platform === 'win32') {
    const appData = env.APPDATA || win32.join(homedir, 'AppData', 'Roaming');
    return win32.join(appData, 'cloudgate');
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg && posix.isAbsolute(xdg) ? xdg : posix.join(homedir, '.config');
  return posix.join(base, 'cloudgate');
}
