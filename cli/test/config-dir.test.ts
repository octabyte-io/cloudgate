import { describe, expect, it } from 'vitest';

import { configDir } from '../src/config-dir.js';

describe('configDir', () => {
  it('is CLOUDGATE_CONFIG_DIR when it is set, on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(
        configDir({
          env: {
            CLOUDGATE_CONFIG_DIR: '/srv/cg',
            XDG_CONFIG_HOME: '/x',
            APPDATA: 'C:\\A',
          },
          platform,
          homedir: '/home/ada',
        }),
      ).toBe('/srv/cg');
    }
  });

  it.each(['linux', 'darwin'] as const)(
    'is $XDG_CONFIG_HOME/cloudgate on %s',
    (platform) => {
      expect(
        configDir({
          env: { XDG_CONFIG_HOME: '/home/ada/.xdg' },
          platform,
          homedir: '/home/ada',
        }),
      ).toBe('/home/ada/.xdg/cloudgate');
    },
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['relative, which the XDG spec says to ignore', 'xdg'],
  ])('is ~/.config/cloudgate when XDG_CONFIG_HOME is %s', (_, xdg) => {
    expect(
      configDir({
        env: { XDG_CONFIG_HOME: xdg },
        platform: 'linux',
        homedir: '/home/ada',
      }),
    ).toBe('/home/ada/.config/cloudgate');
  });

  it('is %APPDATA%\\cloudgate on Windows, whatever XDG_CONFIG_HOME says', () => {
    expect(
      configDir({
        env: {
          APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
          XDG_CONFIG_HOME: '/x',
        },
        platform: 'win32',
        homedir: 'C:\\Users\\ada',
      }),
    ).toBe('C:\\Users\\ada\\AppData\\Roaming\\cloudgate');
  });

  it('falls back to the roaming AppData folder on Windows when APPDATA is unset', () => {
    expect(
      configDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\ada' }),
    ).toBe('C:\\Users\\ada\\AppData\\Roaming\\cloudgate');
  });

  it('counts an empty CLOUDGATE_CONFIG_DIR as unset', () => {
    expect(
      configDir({
        env: { CLOUDGATE_CONFIG_DIR: '' },
        platform: 'linux',
        homedir: '/home/ada',
      }),
    ).toBe('/home/ada/.config/cloudgate');
  });
});
