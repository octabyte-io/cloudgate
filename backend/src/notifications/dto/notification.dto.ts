import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The event flags every channel's create/update body carries. Each defaults
// to false, so a create need not name the events it leaves off.
export const eventFlagsSchema = z.object({
  appDeploy: z.boolean().default(false),
  appBuildError: z.boolean().default(false),
  databaseBackup: z.boolean().default(false),
  volumeBackup: z.boolean().default(false),
  instanceBackup: z.boolean().default(false),
  instanceRestart: z.boolean().default(false),
  dockerCleanup: z.boolean().default(false),
  serverThreshold: z.boolean().default(false),
  // Defaulted off like the rest, so channels that already exist stay
  // silent about it until somebody ticks it.
  licenseLapse: z.boolean().default(false),
  // Off unless ticked, like every flag.
  licenseExpiring: z.boolean().default(false),
  // Off unless ticked, so an Agent's 429s reach nobody who did not ask.
  agentRateLimited: z.boolean().default(false),
  // Off unless ticked, like every flag.
  previewTeardownStuck: z.boolean().default(false),
  // Off unless ticked, like every flag.
  serviceIncident: z.boolean().default(false),
  // Off unless ticked, like every flag.
  aiModelNotAnswering: z.boolean().default(false),
});

const baseCreateSchema = eventFlagsSchema.extend({
  name: z.string().min(1, 'name cannot be empty'),
});

export const createSlackSchema = baseCreateSchema.extend({
  webhookUrl: z.string().min(1, 'webhookUrl cannot be empty'),
  channel: z.string().optional(),
});
export class CreateSlackDto extends createZodDto(createSlackSchema) {}

export const updateSlackSchema = createSlackSchema.partial();
export class UpdateSlackDto extends createZodDto(updateSlackSchema) {}

export const createTelegramSchema = baseCreateSchema.extend({
  botToken: z.string().min(1, 'botToken cannot be empty'),
  chatId: z.string().min(1, 'chatId cannot be empty'),
  messageThreadId: z.string().optional(),
});
export class CreateTelegramDto extends createZodDto(createTelegramSchema) {}

export const updateTelegramSchema = createTelegramSchema.partial();
export class UpdateTelegramDto extends createZodDto(updateTelegramSchema) {}

export const createDiscordSchema = baseCreateSchema.extend({
  webhookUrl: z.string().min(1, 'webhookUrl cannot be empty'),
  decoration: z.boolean().optional(),
});
export class CreateDiscordDto extends createZodDto(createDiscordSchema) {}

export const updateDiscordSchema = createDiscordSchema.partial();
export class UpdateDiscordDto extends createZodDto(updateDiscordSchema) {}

export const createEmailSchema = baseCreateSchema.extend({
  smtpServer: z.string().min(1, 'smtpServer cannot be empty'),
  smtpPort: z.number().min(1),
  username: z.string().min(1, 'username cannot be empty'),
  password: z.string().min(1, 'password cannot be empty'),
  fromAddress: z.string().min(1, 'fromAddress cannot be empty'),
  toAddresses: z.array(z.string()).min(1, 'toAddresses cannot be empty'),
});
export class CreateEmailDto extends createZodDto(createEmailSchema) {}

export const updateEmailSchema = createEmailSchema.partial();
export class UpdateEmailDto extends createZodDto(updateEmailSchema) {}

export const createResendSchema = baseCreateSchema.extend({
  apiKey: z.string().min(1, 'apiKey cannot be empty'),
  fromAddress: z.string().min(1, 'fromAddress cannot be empty'),
  toAddresses: z.array(z.string()).min(1, 'toAddresses cannot be empty'),
});
export class CreateResendDto extends createZodDto(createResendSchema) {}

export const updateResendSchema = createResendSchema.partial();
export class UpdateResendDto extends createZodDto(updateResendSchema) {}

export const createGotifySchema = baseCreateSchema.extend({
  serverUrl: z.string().min(1, 'serverUrl cannot be empty'),
  appToken: z.string().min(1, 'appToken cannot be empty'),
  priority: z.number().min(1).default(5),
  decoration: z.boolean().optional(),
});
export class CreateGotifyDto extends createZodDto(createGotifySchema) {}

export const updateGotifySchema = createGotifySchema.partial();
export class UpdateGotifyDto extends createZodDto(updateGotifySchema) {}

export const createNtfySchema = baseCreateSchema.extend({
  serverUrl: z.string().min(1, 'serverUrl cannot be empty'),
  topic: z.string().min(1, 'topic cannot be empty'),
  accessToken: z.string().optional(),
  priority: z.number().min(1).default(3),
});
export class CreateNtfyDto extends createZodDto(createNtfySchema) {}

export const updateNtfySchema = createNtfySchema.partial();
export class UpdateNtfyDto extends createZodDto(updateNtfySchema) {}

export const createMattermostSchema = baseCreateSchema.extend({
  webhookUrl: z.url(),
  channel: z.string().optional(),
  username: z.string().optional(),
});
export class CreateMattermostDto extends createZodDto(createMattermostSchema) {}

export const updateMattermostSchema = createMattermostSchema.partial();
export class UpdateMattermostDto extends createZodDto(updateMattermostSchema) {}

export const createCustomSchema = baseCreateSchema.extend({
  endpoint: z.string().min(1, 'endpoint cannot be empty'),
  headers: z.record(z.string(), z.string()).optional(),
});
export class CreateCustomDto extends createZodDto(createCustomSchema) {}

export const updateCustomSchema = createCustomSchema.partial();
export class UpdateCustomDto extends createZodDto(updateCustomSchema) {}

export const createLarkSchema = baseCreateSchema.extend({
  webhookUrl: z.string().min(1, 'webhookUrl cannot be empty'),
});
export class CreateLarkDto extends createZodDto(createLarkSchema) {}

export const updateLarkSchema = createLarkSchema.partial();
export class UpdateLarkDto extends createZodDto(updateLarkSchema) {}

// Pushover: emergency priority (2) requires retry/expire.
const pushoverFields = {
  userKey: z.string().min(1, 'userKey cannot be empty'),
  apiToken: z.string().min(1, 'apiToken cannot be empty'),
  priority: z.number().min(-2).max(2).default(0),
  retry: z.number().min(30).nullish(),
  expire: z.number().min(1).max(10800).nullish(),
};

const emergencyNeedsRetryExpire = (data: {
  priority?: number;
  retry?: number | null;
  expire?: number | null;
}) => data.priority !== 2 || (data.retry != null && data.expire != null);

export const createPushoverSchema = baseCreateSchema
  .extend(pushoverFields)
  .refine(emergencyNeedsRetryExpire, {
    message: 'Retry and expire are required for emergency priority (2)',
    path: ['retry'],
  });
export class CreatePushoverDto extends createZodDto(createPushoverSchema) {}

export const updatePushoverSchema = baseCreateSchema
  .extend(pushoverFields)
  .partial()
  .refine(emergencyNeedsRetryExpire, {
    message: 'Retry and expire are required for emergency priority (2)',
    path: ['retry'],
  });
export class UpdatePushoverDto extends createZodDto(updatePushoverSchema) {}

export const createTeamsSchema = baseCreateSchema.extend({
  webhookUrl: z.string().min(1, 'webhookUrl cannot be empty'),
});
export class CreateTeamsDto extends createZodDto(createTeamsSchema) {}

export const updateTeamsSchema = createTeamsSchema.partial();
export class UpdateTeamsDto extends createZodDto(updateTeamsSchema) {}

// Test-connection inputs: the connection fields alone.
export class TestSlackDto extends createZodDto(
  createSlackSchema.pick({ webhookUrl: true, channel: true }),
) {}
export class TestTelegramDto extends createZodDto(
  createTelegramSchema.pick({
    botToken: true,
    chatId: true,
    messageThreadId: true,
  }),
) {}
export class TestDiscordDto extends createZodDto(
  createDiscordSchema.pick({ webhookUrl: true, decoration: true }),
) {}
export class TestEmailDto extends createZodDto(
  createEmailSchema.pick({
    smtpServer: true,
    smtpPort: true,
    username: true,
    password: true,
    fromAddress: true,
    toAddresses: true,
  }),
) {}
export class TestResendDto extends createZodDto(
  createResendSchema.pick({
    apiKey: true,
    fromAddress: true,
    toAddresses: true,
  }),
) {}
export class TestGotifyDto extends createZodDto(
  createGotifySchema.pick({
    serverUrl: true,
    appToken: true,
    priority: true,
    decoration: true,
  }),
) {}
export class TestNtfyDto extends createZodDto(
  createNtfySchema.pick({
    serverUrl: true,
    topic: true,
    accessToken: true,
    priority: true,
  }),
) {}
export class TestMattermostDto extends createZodDto(
  createMattermostSchema.pick({
    webhookUrl: true,
    channel: true,
    username: true,
  }),
) {}
export class TestCustomDto extends createZodDto(
  createCustomSchema.pick({ endpoint: true, headers: true }),
) {}
export class TestLarkDto extends createZodDto(
  createLarkSchema.pick({ webhookUrl: true }),
) {}
export class TestPushoverDto extends createZodDto(
  z.object(pushoverFields).refine(emergencyNeedsRetryExpire, {
    message: 'Retry and expire are required for emergency priority (2)',
    path: ['retry'],
  }),
) {}
export class TestTeamsDto extends createZodDto(
  createTeamsSchema.pick({ webhookUrl: true }),
) {}

// `POST /notifications/receive` input — the metrics agent's alert payload,
// with the agent's PascalCase field names. ServerType "Cloudgate" is the
// local instance (token from web-server settings); "Remote" is a Server.
export const receiveServerThresholdSchema = z.object({
  ServerType: z.enum(['Cloudgate', 'Remote']).default('Cloudgate'),
  Type: z.enum(['Memory', 'CPU']),
  Value: z.number(),
  Threshold: z.number(),
  Message: z.string(),
  Timestamp: z.string(),
  Token: z.string(),
});
export class ReceiveServerThresholdDto extends createZodDto(
  receiveServerThresholdSchema,
) {}
