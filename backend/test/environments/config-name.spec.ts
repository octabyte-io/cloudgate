import { mintConfigName } from '../../src/environments/config-name';
import { CONFIG_NAME_REGEX } from '../../src/project-config';

describe('mintConfigName', () => {
  const none = new Set<string>();

  it('slugs the display name to lowercase letters, digits and hyphens', () => {
    expect(mintConfigName('Shop API', 'application', none)).toBe('shop-api');
    expect(mintConfigName('  Orders_DB (main) ', 'postgres', none)).toBe(
      'orders-db-main',
    );
    expect(mintConfigName('web--2', 'application', none)).toBe('web-2');
  });

  it('adds -2, -3, … on a clash, stepping over a suffix already taken', () => {
    expect(mintConfigName('Web', 'application', new Set(['web']))).toBe(
      'web-2',
    );
    expect(
      mintConfigName('Web', 'application', new Set(['web', 'web-2'])),
    ).toBe('web-3');
  });

  it('gives a display name that slugs to nothing the kind as its name', () => {
    expect(mintConfigName('???', 'postgres', none)).toBe('postgres');
    expect(mintConfigName('日本', 'redis', new Set(['redis']))).toBe('redis-2');
  });

  it('puts the kind in front of a name that would start with a digit', () => {
    expect(mintConfigName('2048 Game', 'application', none)).toBe(
      'application-2048-game',
    );
  });

  it('keeps a long name, suffix included, within 63 characters', () => {
    const long = 'a'.repeat(80);
    expect(mintConfigName(long, 'application', none)).toBe('a'.repeat(63));
    expect(mintConfigName(long, 'application', new Set(['a'.repeat(63)]))).toBe(
      `${'a'.repeat(61)}-2`,
    );
  });

  it('always answers a valid Config name', () => {
    for (const name of ['', '-', '9', 'É', 'x'.repeat(200), 'A-', '--b--']) {
      expect(mintConfigName(name, 'compose', none)).toMatch(CONFIG_NAME_REGEX);
    }
  });
});
