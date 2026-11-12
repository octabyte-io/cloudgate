/**
 * Turns the Instance under test into the Hosted instance (ADR-0049).
 *
 * Call it at the top of an e2e file, before anything imports the app module:
 * `ConfigModule.forRoot({ validate })` reads the environment once, when
 * `createTestApp` first requires `AppModule`, and the instance-mode boot check
 * in `validateEnv` refuses a hosted boot that is missing any setting it lists.
 * So this sets `HOSTED_MODE=true` and every one of those settings, keeping any
 * the file has already set (a billing spec choosing its own Stripe ids).
 *
 * Returns what it set, for a test that wants to assert on a value.
 */
export function useHostedMode(): Record<string, string> {
  const settings: Record<string, string> = {
    HOSTED_MODE: 'true',
    STRIPE_SECRET_KEY: 'sk_test_cloudgate_hosted',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_cloudgate_hosted',
    STARTER_PLAN_PRICE_ID: 'price_starter_plan',
    BUSINESS_PLAN_PRICE_ID: 'price_business_plan',
    ADD_ON_PRICE_ID: 'price_add_on',
    MAIL_PROVIDER: 'resend',
    MAIL_FROM_ADDRESS: 'Cloudgate <hello@cloudgate.test>',
    RESEND_API_KEY: 're_test_cloudgate_hosted',
    SITE_URL: 'https://cloudgate.test',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: 'turnstile-secret-cloudgate-hosted',
  };
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'HOSTED_MODE') process.env[key] = value;
    else process.env[key] ??= value;
    settings[key] = process.env[key];
  }
  return settings;
}
