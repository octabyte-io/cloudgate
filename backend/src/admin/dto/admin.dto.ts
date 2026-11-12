import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The web server's metricsConfig. The type discriminator is not accepted —
// setup always writes 'Cloudgate'.
//
// **`token` is optional, and the three cases are distinct.** The console can no
// longer read the stored token back: it is a live shared credential that
// authenticates `receiveServerThreshold`'s instance-wide branch, so
// `sanitizeWebServerSettings` projects it out of every response this row
// appears in and reports `metricsConfig.server.hasToken` instead. What
// `toMetricsConfig` used to do with the value it read — re-submit it unchanged,
// so that saving a threshold tweak did not rotate a token an operator may have
// configured an external agent with — is now the route's job:
//
// - **omitted** → keep whatever is stored. `updateSlackSchema.partial()` plus
//   `defined()` is the same contract on the notification channel credentials,
//   and it is why this is optional rather than nullable.
// - **`''`** → clear it, which is the only way to stop collecting
//   (`stopCollecting` in the console, `registerTarget`'s early return here).
//   So an empty string must stay distinguishable from an absent key, which
//   rules out `.default('')`.
// - **anything else** → set or rotate it.
const metricsConfigSchema = z.object({
  server: z.object({
    refreshRate: z.number().min(2),
    port: z.number().min(1),
    token: z.string().optional(),
    urlCallback: z.url(),
    retentionDays: z.number().min(1),
    cronJob: z.string().min(1),
    thresholds: z.object({
      cpu: z.number().min(0),
      memory: z.number().min(0),
    }),
  }),
  containers: z.object({
    refreshRate: z.number().min(2),
    services: z.object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
  }),
});

export class SetupWebMonitoringBodyDto extends createZodDto(
  z.object({ metricsConfig: metricsConfigSchema }),
) {}
