import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { validateEnv } from '../../src/common/config/env.schema';
import {
  checkInstanceModeBoot,
  InstanceModeBootError,
} from '../../src/instance-mode/instance-mode';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';

/**
 * The instance-mode boot check (ADR-0049): a pure check over the
 * environment, run before anything else reads it.
 */

/** Everything a hosted boot needs, so a test can take one or more away. */
const HOSTED_SETTINGS = {
  HOSTED_MODE: 'true',
  STRIPE_SECRET_KEY: 'sk_test_cloudgate',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_cloudgate',
  STARTER_PLAN_PRICE_ID: 'price_starter_plan',
  BUSINESS_PLAN_PRICE_ID: 'price_business_plan',
  ADD_ON_PRICE_ID: 'price_add_on',
  MAIL_PROVIDER: 'resend',
  MAIL_FROM_ADDRESS: 'Cloudgate <hello@cloudgate.test>',
  RESEND_API_KEY: 're_test_cloudgate',
  SITE_URL: 'https://cloudgate.test',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
} as const;

/** The rest of what the env schema needs to accept a boot at all. */
const BASE_ENV = {
  DATABASE_URL: 'postgresql://localhost/cloudgate',
  APP_ENCRYPTION_SECRET: 'x'.repeat(32),
  BETTER_AUTH_SECRET: 'y'.repeat(32),
};

function refusal(env: Record<string, unknown>): string {
  try {
    checkInstanceModeBoot(env);
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceModeBootError);
    return (error as Error).message;
  }
  throw new Error('expected the boot check to refuse');
}

describe('checkInstanceModeBoot', () => {
  it('boots self-hosted when HOSTED_MODE is unset', () => {
    expect(checkInstanceModeBoot({})).toBe('self-hosted');
    expect(checkInstanceModeBoot({ HOSTED_MODE: 'false' })).toBe('self-hosted');
    // systemd hands a bare `HOSTED_MODE=` through as an empty string.
    expect(checkInstanceModeBoot({ HOSTED_MODE: '' })).toBe('self-hosted');
  });

  it('boots hosted when HOSTED_MODE=true and every hosted setting is there', () => {
    expect(checkInstanceModeBoot({ ...HOSTED_SETTINGS })).toBe('hosted');
  });

  it.each(['true', 'false'])(
    'refuses a stale IS_CLOUD=%s, saying it was renamed to HOSTED_MODE',
    (value) => {
      const message = refusal({ IS_CLOUD: value });
      expect(message).toContain('IS_CLOUD');
      expect(message).toMatch(/renamed/);
      expect(message).toContain('HOSTED_MODE');
    },
  );

  it('refuses a stale IS_CLOUD even beside a complete hosted configuration', () => {
    const message = refusal({ ...HOSTED_SETTINGS, IS_CLOUD: 'true' });
    expect(message).toMatch(/IS_CLOUD .*renamed/);
  });

  it('refuses a HOSTED_MODE that is neither true nor false', () => {
    expect(refusal({ HOSTED_MODE: 'yes' })).toMatch(
      /HOSTED_MODE must be "true" or "false"/,
    );
  });

  it('names every missing hosted setting in one message', () => {
    const message = refusal({
      HOSTED_MODE: 'true',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_cloudgate',
      ADD_ON_PRICE_ID: 'price_add_on',
      MAIL_FROM_ADDRESS: 'Cloudgate <hello@cloudgate.test>',
      // Blank is missing: a bare key in the environment file.
      SITE_URL: '  ',
    });

    for (const missing of [
      'STRIPE_SECRET_KEY',
      'STARTER_PLAN_PRICE_ID',
      'BUSINESS_PLAN_PRICE_ID',
      'MAIL_PROVIDER',
      'RESEND_API_KEY',
      'SITE_URL',
      'TURNSTILE_SITE_KEY',
      'TURNSTILE_SECRET_KEY',
    ]) {
      expect(message).toContain(missing);
    }
    for (const present of [
      'STRIPE_WEBHOOK_SECRET',
      'ADD_ON_PRICE_ID',
      'MAIL_FROM_ADDRESS',
    ]) {
      expect(message).not.toContain(present);
    }
  });

  it('refuses a hosted boot whose mail goes anywhere but Resend', () => {
    const message = refusal({ ...HOSTED_SETTINGS, MAIL_PROVIDER: 'smtp' });
    expect(message).toContain('MAIL_PROVIDER');
    expect(message).toContain('resend');
  });

  it('ignores Stripe settings when self-hosted, however incomplete', () => {
    expect(
      checkInstanceModeBoot({
        STRIPE_SECRET_KEY: 'sk_live_left_over',
        STARTER_PLAN_PRICE_ID: '',
        MAIL_PROVIDER: 'smtp',
      }),
    ).toBe('self-hosted');
  });

  it('boots hosted with or without the Bought Server provider settings (ADR-0071)', () => {
    // HOSTED_SETTINGS names none of them; a Hosted instance without the
    // tokens simply offers no Buy a Server.
    expect(validateEnv({ ...BASE_ENV, ...HOSTED_SETTINGS }).HOSTED_MODE).toBe(
      true,
    );
    const withThem = validateEnv({
      ...BASE_ENV,
      ...HOSTED_SETTINGS,
      HETZNER_EUR_API_TOKEN: 'eur-token',
      HETZNER_USD_API_TOKEN: 'usd-token',
      BOUGHT_SERVER_REVERSE_DNS_DOMAIN: 'servers.octabyte.app',
    });
    expect(withThem.HETZNER_EUR_API_TOKEN).toBe('eur-token');
    expect(withThem.HETZNER_USD_API_TOKEN).toBe('usd-token');
    expect(withThem.BOUGHT_SERVER_REVERSE_DNS_DOMAIN).toBe(
      'servers.octabyte.app',
    );
  });

  it('is what validateEnv runs, so a refused boot never starts', () => {
    expect(() => validateEnv({ ...BASE_ENV, IS_CLOUD: 'false' })).toThrow(
      /IS_CLOUD .*renamed/,
    );
    expect(() => validateEnv({ ...BASE_ENV, HOSTED_MODE: 'true' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(validateEnv({ ...BASE_ENV, ...HOSTED_SETTINGS }).HOSTED_MODE).toBe(
      true,
    );
    expect(validateEnv({ ...BASE_ENV }).HOSTED_MODE).toBe(false);
  });
});

describe('checkInstanceModeBoot against the recorded mode', () => {
  function refusalWith(
    env: Record<string, unknown>,
    recorded: 'hosted' | 'self-hosted',
  ): string {
    try {
      checkInstanceModeBoot(env, recorded);
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceModeBootError);
      return (error as Error).message;
    }
    throw new Error('expected the boot check to refuse');
  }

  it('boots the first start, which has no recorded mode yet', () => {
    expect(checkInstanceModeBoot({}, null)).toBe('self-hosted');
    expect(checkInstanceModeBoot({ ...HOSTED_SETTINGS }, null)).toBe('hosted');
  });

  it('boots a later start whose setting matches the recorded mode', () => {
    expect(checkInstanceModeBoot({}, 'self-hosted')).toBe('self-hosted');
    expect(checkInstanceModeBoot({ ...HOSTED_SETTINGS }, 'hosted')).toBe(
      'hosted',
    );
  });

  it('refuses a Hosted instance whose setting was dropped, naming both modes', () => {
    // install.sh rewrote the environment file without HOSTED_MODE.
    const message = refusalWith({}, 'hosted');
    expect(message).toContain('recorded mode is hosted');
    expect(message).toContain('setting says self-hosted');
    expect(message).toContain('HOSTED_MODE=true');
    expect(message).toContain('set-instance-mode');
  });

  it('refuses a Self-hosted instance started with hosted mode on, naming both modes', () => {
    const message = refusalWith({ ...HOSTED_SETTINGS }, 'self-hosted');
    expect(message).toContain('recorded mode is self-hosted');
    expect(message).toContain('setting says hosted');
    expect(message).toContain('--mode hosted');
  });

  it('still refuses a stale IS_CLOUD first, whatever is recorded', () => {
    expect(refusalWith({ IS_CLOUD: 'true' }, 'self-hosted')).toMatch(
      /IS_CLOUD .*renamed/,
    );
  });
});

describe('InstanceMode', () => {
  function instanceMode(hosted: boolean | undefined): InstanceMode {
    const config = { get: () => hosted } as unknown as ConfigService;
    return new InstanceMode(config);
  }

  it('answers hosted and self-hosted off the validated setting', () => {
    expect(instanceMode(true).isHosted).toBe(true);
    expect(instanceMode(true).mode).toBe('hosted');
    expect(instanceMode(false).isHosted).toBe(false);
    expect(instanceMode(false).mode).toBe('self-hosted');
    expect(instanceMode(undefined).mode).toBe('self-hosted');
  });

  it.each([
    [true, 'Instance mode: hosted'],
    [false, 'Instance mode: self-hosted'],
  ])('logs the mode at boot (hosted=%s)', (hosted, line) => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    try {
      instanceMode(hosted).onApplicationBootstrap();
      expect(log).toHaveBeenCalledWith(line);
    } finally {
      log.mockRestore();
    }
  });
});
