import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Output } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { ai } from '../db/schema';
import type { Ai } from '../db/schema';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { ServersService } from '../servers/servers.service';
import { SettingsService } from '../settings/settings.service';
import { ComposeService } from '../compose/compose.service';
import { DomainsService } from '../domains/domains.service';
import { environment, project } from '../db/schema';
import { FETCH_CLIENT } from '../git-providers/fetch.provider';
import type { FetchClient } from '../git-providers/fetch.provider';
import { MountsService } from '../mounts/mounts.service';
import { capMessage } from '../notifications/channels/cap-message';
import {
  isOutboundAddressRefusal,
  OutboundAddressGuard,
} from '../outbound/outbound-address-guard';
import { generatePassword } from './generate-password';
import { slugify } from './slug';
// The composed-create rule, imported rather than restated (§1.4).
import { composedCreateStatements } from '../compose/composed-create-statements';
import { ADDRESS_RESOLVER, assertPublicApiUrl } from './ai-destination';
import type { AddressResolver } from './ai-destination';
import type {
  AnalyzeLogsDto,
  CreateAiDto,
  DeployAiDto,
  GetModelsDto,
  SuggestAiDto,
  TestConnectionDto,
  UpdateAiDto,
} from './dto/ai.dto';
import { AI_GENERATION_TIMEOUT_MS, TEXT_GENERATOR } from './llm.provider';
import type {
  TextGenerationArgs,
  TextGenerationResult,
  TextGenerator,
} from './llm.provider';
import {
  getProviderHeaders,
  getProviderName,
  selectAIProvider,
} from './select-ai-provider';
import type { Model } from './select-ai-provider';

interface SuggestionItem {
  id: string;
  name: string;
  shortDescription: string;
  description: string;
}

interface DockerOutput {
  dockerCompose: string;
  envVariables: Array<{ name: string; value: string }>;
  domains: Array<{ host: string; port: number; serviceName: string }>;
  configFiles?: Array<{ content: string; filePath: string }> | null;
}

export type AiSuggestion = SuggestionItem & DockerOutput;

/** An AI config as exposed over the API — the apiKey never leaves the server. */
export type SanitizedAi = Omit<Ai, 'apiKey'>;

function stripApiKey(row: Ai): SanitizedAi {
  const { apiKey, ...rest } = row;
  void apiKey;
  return rest;
}

/**
 * Take the stored key back out of a provider's own words before they are shown.
 *
 * Needed only by the id-taking test: providers do quote the key they
 * rejected, and on that route the caller never sent it and so cannot redact its
 * own copy the way the credential-taking form does. The diagnosis is the reason
 * the refusal is worth reading, so only the key itself goes; a value under six
 * characters is left alone (it would eat unrelated words, and a key that short
 * is not a key). The destinations `redactS3Credentials` precedent.
 */
function redactApiKey(message: string, apiKey: string): string {
  if (!apiKey || apiKey.length < 6) return message;
  return message.split(apiKey).join('••••••');
}

/**
 * How much of a provider's own words a refusal from the two probes carries.
 *
 * The words stay: an operator debugging a wrong base URL or a rejected key
 * reads the upstream message, which is why it was put there and why
 * the owner/admin gating left it alone. What is not load-bearing is its *length*. `getModels`
 * threw `Failed to fetch models: ${await response.text()}` — the target's
 * entire response body — and `probeProvider` hands on the SDK's message, which
 * for a target that is not an LLM quotes the status line and often the body it
 * could not parse. So both probes answered with the *response* rather than a
 * verdict, and the gating bounded who may aim them without bounding that: an instance
 * owner or admin is exempt from the destination check by design (ADR-0013,
 * `ai-destination.ts`). Every other Organization's dial is now guarded at the
 * connection (`providerFetch`), so a redirect or a rebind to an internal
 * address is refused before anything is read; the cap still bounds what a
 * public target says.
 *
 * Dropping the message was the other candidate and is rejected for the
 * same reason — a probe that answers only "failed" is a probe nobody can act on.
 * 500 code units is the smallest of the three limits `capMessage` already
 * serves: room for a provider's sentence and its error code, not for a page. A
 * cut message ends in `…`, so the operator knows the provider said more rather
 * than reading a sentence that simply stops; that one character is outside the
 * cap on purpose, because the cap is about how much of the *target's* text is
 * repeated and the marker is ours.
 *
 * **`capMessage` is imported rather than reimplemented, across a module
 * boundary §2.1 does not name.** It is a pure function with no Nest wiring —
 * the same shape of import `hostSchema` and `filePathSchema` (domains, mounts) make in
 * `dto/ai.dto.ts`, each for the §1.4/§2.4 reason that one rule lives in one
 * place. The property it holds is the one a local `substring` gets wrong: a cut
 * between the halves of a surrogate pair leaves a lone surrogate, which
 * survives JSON but not a receiver that re-encodes the field. It exists because
 * nine copies of that `substring` were each written the same wrong way (H-122),
 * so a tenth here would be the mistake it was written to end. Its home is
 * arguably `common/`; moving it is a change to the notifications module rather
 * than to this one, and is recorded rather than done.
 */
const UPSTREAM_MESSAGE_LIMIT = 500;

/** The upstream message, capped, and marked as cut when it was. */
function boundUpstreamMessage(message: string): string {
  const capped = capMessage(message, UPSTREAM_MESSAGE_LIMIT);
  return capped === message ? message : `${capped}…`;
}

@Injectable()
export class AiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(TEXT_GENERATOR) private readonly generateText: TextGenerator,
    @Inject(FETCH_CLIENT) private readonly fetchClient: FetchClient,
    @Inject(ADDRESS_RESOLVER)
    private readonly resolveAddresses: AddressResolver,
    private readonly permissions: PermissionService,
    private readonly servers: ServersService,
    private readonly settings: SettingsService,
    private readonly compose: ComposeService,
    private readonly domains: DomainsService,
    private readonly mounts: MountsService,
    private readonly outbound: OutboundAddressGuard,
  ) {}

  /**
   * The fetch every request to an AI provider goes through, for the
   * Organization the provider is configured for: `FETCH_CLIENT` with every
   * connection checked and pinned by `OutboundAddressGuard`, redirect hops
   * included, unless that Organization is the instance organization
   * (ADR-0013), whose dials are left as they were.
   *
   * **Why at the dial and not only where the URL enters.**
   * `assertDestinationAllowed` checks the `apiUrl` once, by name; the fetch
   * then followed a redirect wherever it pointed and resolved the name again
   * at connect. A customer's provider that answered `/models` with a 302 to
   * the metadata address had the platform host fetch it and quote the body
   * back in the refusal, and the SDK probes did the same through their own
   * fetch. Both now take this one, so a hop to a private address is refused
   * before it connects and nothing it would have said is read.
   *
   * Scoped to the Organization, not to who asks: `suggest` and `analyzeLogs`
   * are a plain member spending a destination their owner saved, and a stored
   * destination belongs to its row's Organization. So an instance owner
   * acting in a *second* Organization is that Organization's dial here, as a
   * notification channel there would be.
   */
  private providerFetch(organizationId: string): FetchClient {
    return this.outbound.fetchFor(this.fetchClient, {
      place: { organizationId },
      field: 'apiUrl',
    });
  }

  /**
   * Every AI call goes through here, so every one has the same stated ceiling
   * `AI_GENERATION_TIMEOUT_MS`, after which the provider request is
   * aborted and the caller's own catch turns the sentence below into its 400.
   *
   * **A race and an abort, not either alone.** The abort is what stops the
   * provider generating into a response nobody will read; the race is what
   * answers on time when a provider client does not honour the signal. The
   * refusal settles *before* the abort fires, so the sentence that wins is this
   * one and not the SDK's `This operation was aborted`, which names neither the
   * cause nor the wait.
   *
   * 400 rather than 504 because the console renders a 5xx as its own sentence
   * about the backend being down or faulty (`errorMessage`), which is the very
   * misreport to avoid; a 400 carries these words to the screen verbatim,
   * the same way every other provider refusal from this module does.
   */
  private async generate(
    args: Omit<TextGenerationArgs, 'abortSignal'>,
  ): Promise<TextGenerationResult> {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `The AI provider did not answer within ${AI_GENERATION_TIMEOUT_MS / 1000} seconds, so Cloudgate stopped waiting and nothing was produced. A faster model, or a shorter request, may finish in time`,
          ),
        );
        deadline.abort();
      }, AI_GENERATION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.generateText({ ...args, abortSignal: deadline.signal }),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Only owner/admin members manage AI configs. */
  private async ensureOwnerOrAdmin(ctx: PermissionCtx): Promise<void> {
    const member = await this.permissions.findMember(ctx);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage AI settings',
      );
    }
  }

  /**
   * Where this caller may point the platform host, for the four routes that
   * take an `apiUrl` out of a request body.
   *
   * The reasoning is `ai-destination.ts`'s docblock and ADR-0013's: choosing a
   * private-network destination for the host to dial is an instance-wide act,
   * so it takes instance authority, and a caller who holds that already has a
   * root shell on the same host — for whom the check would be theatre. It is
   * applied **where the URL enters the system** rather than only at the two
   * probes themselves, and that placement is the whole of what makes it a gate:
   * `POST /ai` is owner/admin too, so a guard on the probes alone would be
   * bypassed by storing the URL first and probing the row.
   *
   * `suggest` and `analyzeLogs` are deliberately not on the list. They take an
   * `aiId` and no URL, so the destination is one an owner or admin already
   * committed rather than one the caller chose — and they are reachable by a
   * plain member (see their docblocks), who has no instance authority, so
   * asking this question there would refuse a member the local Ollama their
   * owner configured, which is the flow this check exists to preserve.
   */
  private async assertDestinationAllowed(
    ctx: PermissionCtx,
    apiUrl: string,
  ): Promise<void> {
    if (await this.hasInstanceAuthority(ctx)) return;
    await assertPublicApiUrl(apiUrl, this.resolveAddresses);
  }

  /**
   * `checkInstanceAuthority` asked as a predicate.
   *
   * It answers by throwing, which is right for its dozen call sites and wrong
   * for the one above, where instance authority is not the requirement but the
   * exemption. Caught here rather than answered by a second copy of the
   * instance-organization lookup in this module: `common/owned-server.ts`
   * records what five copies of one authority question cost, and ADR-0013's
   * authority is defined in exactly one place on purpose. Only the refusal is
   * swallowed — anything else is a real failure and travels.
   */
  private async hasInstanceAuthority(ctx: PermissionCtx): Promise<boolean> {
    try {
      await this.permissions.checkInstanceAuthority(ctx);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** Creates an AI config in the active organization; owner/admin only. */
  async create(ctx: PermissionCtx, data: CreateAiDto): Promise<SanitizedAi> {
    await this.ensureOwnerOrAdmin(ctx);
    await this.assertDestinationAllowed(ctx, data.apiUrl);
    const [created] = await this.db
      .insert(ai)
      .values({ ...data, organizationId: ctx.session.activeOrganizationId })
      .returning();
    return stripApiKey(created);
  }

  /** The active organization's AI configs, keys stripped; owner/admin only. */
  async list(ctx: PermissionCtx): Promise<SanitizedAi[]> {
    await this.ensureOwnerOrAdmin(ctx);
    const rows = await this.listRows(ctx);
    return rows.map(stripApiKey);
  }

  /**
   * The organization's enabled AI configs, readable by any authenticated
   * member, reduced to the fields the compose UI needs.
   */
  async getEnabledProviders(
    ctx: PermissionCtx,
  ): Promise<Array<{ aiId: string; name: string; model: string }>> {
    const rows = await this.listRows(ctx);
    return rows
      .filter((row) => row.isEnabled)
      .map((row) => ({ aiId: row.aiId, name: row.name, model: row.model }));
  }

  /** One AI config, org-scoped, key stripped; owner/admin only. */
  async findOne(ctx: PermissionCtx, aiId: string): Promise<SanitizedAi> {
    await this.ensureOwnerOrAdmin(ctx);
    return stripApiKey(await this.findOneWithCredentials(ctx, aiId));
  }

  /** Updates an AI config, org-scoped through the lookup; owner/admin only. */
  async update(
    ctx: PermissionCtx,
    aiId: string,
    data: UpdateAiDto,
  ): Promise<SanitizedAi> {
    await this.ensureOwnerOrAdmin(ctx);
    // Only when this body carries one: the schema is `.partial()`, and a PATCH
    // that omits `apiUrl` keeps the stored destination, which was checked when
    // it was stored.
    if (data.apiUrl !== undefined) {
      await this.assertDestinationAllowed(ctx, data.apiUrl);
    }
    const current = await this.findOneWithCredentials(ctx, aiId);
    const [updated] = await this.db
      .update(ai)
      .set(data)
      .where(eq(ai.aiId, current.aiId))
      .returning();
    return stripApiKey(updated);
  }

  /** Deletes an AI config, org-scoped through the lookup; owner/admin only. */
  async remove(ctx: PermissionCtx, aiId: string): Promise<SanitizedAi> {
    await this.ensureOwnerOrAdmin(ctx);
    const current = await this.findOneWithCredentials(ctx, aiId);
    const [removed] = await this.db
      .delete(ai)
      .where(eq(ai.aiId, current.aiId))
      .returning();
    return stripApiKey(removed);
  }

  /**
   * Drafts up to three deployment suggestions, each a docker compose config,
   * for the caller's `input` through the selected provider, every failure
   * wrapped as a 400. The LLM call goes through the injected generator; the
   * provider/model selection (select-ai-provider.ts) is real code. The
   * serverId is org-scoped through ServersService (docker-ops precedent).
   *
   * **No `ensureOwnerOrAdmin`, and that is the design rather than an
   * omission.** `suggest` is open to any member — `AiController`'s own
   * docblock states the split — and the load-bearing reason is this. Drafting
   * a service is the first step of creating one, and `deploy` below authorizes
   * that step with `checkServiceAccess(projectId, 'create')`: a licensed custom
   * role holding `service: ['create']` may deploy a suggestion (there is a test
   * for exactly that caller), so gating the drafting on the static owner/admin
   * roles would leave a role able to deploy a stack it could never generate.
   * `getEnabledProviders` is member-readable for the same reason and says so —
   * it exists to fill this route's picker.
   *
   * What is true is the cost: the organization's stored credential
   * is spent by whoever calls this, and nothing here meters it. Metering is the
   * open half, and it is not an authorization check.
   */
  async suggest(
    ctx: PermissionCtx,
    input: SuggestAiDto,
  ): Promise<AiSuggestion[]> {
    try {
      return await this.suggestVariants(ctx, input);
    } catch (error) {
      if (isOutboundAddressRefusal(error)) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : `Error: ${String(error)}`,
      );
    }
  }

  private async suggestVariants(
    ctx: PermissionCtx,
    input: SuggestAiDto,
  ): Promise<AiSuggestion[]> {
    const aiSettings = await this.findOneWithCredentials(ctx, input.aiId);
    if (!aiSettings.isEnabled) {
      throw new NotFoundException(
        'AI features are not enabled for this configuration',
      );
    }

    const provider = selectAIProvider({
      ...aiSettings,
      fetch: this.providerFetch(aiSettings.organizationId),
    });
    const model = provider(aiSettings.model);

    const settings = await this.settings.getWebServerSettings();
    let ip = settings?.serverIp || '';

    if (input.serverId) {
      const server = await this.servers.findOne(ctx, input.serverId);
      ip = server.ipAddress;
    } else if (process.env.NODE_ENV === 'development') {
      ip = '127.0.0.1';
    }

    const fullSchema = z.object({
      suggestions: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          shortDescription: z.string(),
          description: z.string(),
          dockerCompose: z.string(),
          envVariables: z.array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          ),
          domains: z.array(
            z.object({
              host: z.string(),
              port: z.number(),
              serviceName: z.string(),
            }),
          ),
          configFiles: z
            .array(
              z.object({
                content: z.string(),
                filePath: z.string(),
              }),
            )
            .nullable(),
        }),
      ),
    });

    const result = await this.generate({
      model,
      output: Output.object({ schema: fullSchema }),
      prompt: `
		    Act as advanced DevOps engineer. Analyze the user's request and generate up to 3 deployment suggestions, each with a complete docker compose configuration.

		    CRITICAL - Read the user's request carefully and follow the appropriate strategy:

		    Strategy A - If the user specifies a PARTICULAR APPLICATION/SERVICE (e.g., "deploy Chatwoot", "install sendingtk/chatwoot:develop", "setup Bitwarden"):
		    - Generate different deployment VARIANTS of that SAME application
		    - Each variant should be a different configuration (minimal, full stack, with different databases, development vs production, etc.)
		    - Example: For "Chatwoot" → "Chatwoot with PostgreSQL", "Chatwoot Development", "Chatwoot Full Stack"
		    - The name MUST include the specific application name the user mentioned

		    Strategy B - If the user describes a GENERAL NEED or USE CASE (e.g., "personal blog", "project management tool", "chat application"):
		    - Suggest different open source projects that fulfill that need
		    - Each suggestion should be a different tool/platform that solves the same problem
		    - Example: For "personal blog" → "WordPress", "Ghost", "Hugo with Nginx"
		    - The name should be the actual project name

		    Return your response as a JSON object with this structure:
		    {
		      "suggestions": [
		        {
		          "id": "project-or-variant-slug",
		          "name": "Project Name or Variant Name",
		          "shortDescription": "Brief one-line description",
		          "description": "Detailed description of the project/variant",
		          "dockerCompose": "yaml string here",
		          "envVariables": [{"name": "VAR_NAME", "value": "example_value"}],
		          "domains": [{"host": "domain.com", "port": 3000, "serviceName": "service"}],
		          "configFiles": [{"content": "file content", "filePath": "path/to/file"}]
		        }
		      ]
		    }

		    Suggestion Rules:
		    1. Use slug format for the id field (lowercase, hyphenated)
		    2. The description field should ONLY contain plain text — no code snippets or installation instructions
		    3. The shortDescription should be a single-line summary focusing on key technologies or differentiators
		    4. All suggestions should be installable in docker and have docker compose support
		    5. Provide variety in your suggestions - different complexity levels, tech stacks, or approaches

		    Docker Compose Rules:
		    1. Use placeholder like \${VARIABLE_NAME-default} for generated variables in the docker-compose.yml
		    2. Use complex values for passwords/secrets variables
		    3. Don't set container_name field in services
		    4. Don't set version field in the docker compose
		    5. Don't set ports like 'ports: 3000:3000', use 'ports: "3000"' instead
		    6. If a service depends on a database or other service, INCLUDE that service in the docker-compose
		    7. Make sure all required services are defined in the docker-compose

		    Docker Image Rules (CRITICAL):
		    1. ALWAYS use 'image:' field, NEVER use 'build:' field
		    2. NEVER use 'build: .' or any build directive - we don't have local Dockerfiles
		    3. Use images from Docker Hub or other public registries (e.g., docker.io, ghcr.io, quay.io)
		    4. For dependencies (databases, redis, etc.), use official images (e.g., postgres:16, redis:8, etc.)
		    5. Always specify image tags - avoid using 'latest' tag, use specific versions when possible
		    6. Examples of correct image usage:
		       - image: sendingtk/chatwoot:develop
		       - image: postgres:16-alpine
		       - image: redis:8-alpine
		    7. Examples of INCORRECT usage (DO NOT USE):
		       - build: .
		       - build: ./app
		       - build:
		           context: .
		           dockerfile: Dockerfile

		    Volume Mounting and Configuration Rules:
		    1. DO NOT create configuration files unless the service CANNOT work without them
		    2. Most services can work with just environment variables - USE THEM FIRST
		    3. If and ONLY IF a config file is absolutely required:
		       - Keep it minimal with only critical settings
		       - Use "../files/" prefix for all mounts
		       - Format: "../files/folder:/container/path"
		    4. DO NOT add configuration files for default configs, env-configurable settings, or proxy/routing configs

		    Environment Variables Rules:
		    1. For the envVariables array, provide ACTUAL example values, not placeholders
		    2. Use realistic example values (e.g., "admin@example.com" for emails, "mypassword123" for passwords)
		    3. DO NOT use \${VARIABLE_NAME-default} syntax in the envVariables values
		    4. ONLY include environment variables that are actually used in the docker-compose
		    5. Every environment variable referenced in the docker-compose MUST have a corresponding entry in envVariables

		    Domain Rules - For each service that needs to be exposed to the internet:
		    1. Define a domain with:
		       - host: {service-name}-{random-3-chars-hex}-${ip ? ip.replaceAll('.', '-') : ''}.sslip.io
		       - port: the internal port the service runs on
		       - serviceName: the name of the service in the docker-compose
		    2. Make sure the service is properly configured to work with the specified port

		    User's request: ${input.input}
		  `,
    });

    const output = result.output as { suggestions: AiSuggestion[] } | undefined;

    if (!output?.suggestions?.length) {
      throw new NotFoundException('No suggestions found');
    }

    return output.suggestions.filter((s) => s.dockerCompose);
  }

  /**
   * Build/runtime log triage through the selected provider, every failure
   * wrapped as a 400. A config in another organization is refused by the
   * org-scoped lookup.
   *
   * **No `ensureOwnerOrAdmin`, deliberately, and the console is where the
   * reason is visible.** `explain-log.tsx` renders this beside a
   * deployment's log for whoever is reading it, and says why in its own
   * docblock: a member watching their build fail is the caller, and
   * `GET /ai/enabled-providers` is member-readable precisely so that screen can
   * offer a provider. Owner/admin here would move log triage to the two people
   * least likely to be reading the log, so the asymmetry with this module's
   * config CRUD is intended — `AiController`'s docblock names the split, and
   * this is the surface the member half is for.
   *
   * The residual is real and is not an authorization one: a member
   * can spend the organization's provider credential at whatever rate they
   * like, and no route here meters it.
   */
  async analyzeLogs(
    ctx: PermissionCtx,
    input: AnalyzeLogsDto,
  ): Promise<{ analysis: string }> {
    try {
      const aiSettings = await this.findOneWithCredentials(ctx, input.aiId);
      if (!aiSettings.isEnabled) {
        throw new BadRequestException('AI provider is not enabled');
      }

      const provider = selectAIProvider({
        ...aiSettings,
        fetch: this.providerFetch(aiSettings.organizationId),
      });
      const model = provider(aiSettings.model);

      const contextLabel =
        input.context === 'build' ? 'build/deployment' : 'runtime/container';

      const result = await this.generate({
        model,
        prompt: `You are a DevOps engineer analyzing ${contextLabel} logs. Analyze the following logs and provide:

1. **Summary**: A brief summary of what's happening
2. **Issues Found**: Any errors, warnings, or problems detected
3. **Root Cause**: The most likely root cause if there are errors
4. **Suggested Fix**: Actionable steps to resolve the issues

Be concise and practical. Focus on the most important issues. If the logs look healthy, say so briefly.

Logs:
${input.logs}`,
      });

      return { analysis: result.text };
    } catch (error) {
      if (isOutboundAddressRefusal(error)) throw error;
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : `Analysis failed: ${String(error)}`,
      );
    }
  }

  /**
   * A one-token round trip against caller-supplied credentials (nothing
   * stored), failures wrapped as 400.
   *
   * **Both gates arrived later, and the `ctx` used to be spelled `_ctx`.**
   * Until then the route was open to any member, which on this route means
   * every member of every Organization could make the backend dial a URL of
   * their choosing from inside the platform host's network. Owner/admin like
   * the rest of the module is the smaller half;
   * `assertDestinationAllowed` is the half that answers the SSRF, and
   * `ai-destination.ts` carries the argument.
   *
   * Both run **before** `probeProvider`, and the refusal is not inside a
   * try/catch: `probeProvider` rewraps everything it catches as a 400 with the
   * provider's own words, so a gate that threw from in there would answer 403's
   * sentence with a 400's status.
   *
   * What comes back is worth reading before this route is trusted with a
   * destination. Success is the bare verdict `Connection successful`, which is
   * already a liveness and port oracle and stays that way — the route's whole
   * job is to answer whether this destination works, so there is nothing to
   * bound there, and the two gates are what stand between that oracle and a
   * caller. A failure carries the provider's message — for a target that is not
   * an LLM, the SDK quoting the status line and often the body it could not
   * parse — which is why it is capped in `probeProvider`, the one place both
   * probes share.
   */
  async testConnection(
    ctx: PermissionCtx,
    input: TestConnectionDto,
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureOwnerOrAdmin(ctx);
    await this.assertDestinationAllowed(ctx, input.apiUrl);
    return this.probeProvider(
      input,
      ctx.session.activeOrganizationId,
      (message) => message,
    );
  }

  /**
   * The same probe against a config that is already saved.
   *
   * `testConnection` takes the URL, the key and the model, which is the right
   * way round for a create — you cannot pick a model from a provider you have
   * not authenticated to. It is no use afterwards: the key is stripped on every
   * read, so the console cannot send it back, and a rotated or revoked key could
   * not be discovered from this screen at all.
   *
   * Owner/admin like every other route that names a config, and org-scoped
   * through `findOneWithCredentials` — an id from another Organization is
   * absent. The stored key is masked out of a refusal, because the caller never
   * held it and so cannot take it back out of the provider's own words.
   */
  async testSavedConnection(
    ctx: PermissionCtx,
    aiId: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureOwnerOrAdmin(ctx);
    const found = await this.findOneWithCredentials(ctx, aiId);
    // The stored URL is checked here too, not only where it was stored.
    // Rows predating that check exist, and this is the one route that probes a
    // stored destination for a caller who may be an owner of a *second*
    // Organization — the caller `assertDestinationAllowed` is about.
    await this.assertDestinationAllowed(ctx, found.apiUrl);
    return this.probeProvider(found, found.organizationId, (message) =>
      redactApiKey(message, found.apiKey),
    );
  }

  /**
   * A one-token round trip: nothing back from the model is a failure.
   *
   * **The refusal is capped, and capped *after* the redaction.** The
   * message here is milder than `getModels`' — it is the SDK's sentence, not
   * `response.text()` — but "milder" is not "bounded": aimed at something that
   * is not an LLM, the provider factory reports what it could not parse, so the
   * body arrives inside the SDK's own words. One cap for both probes rather
   * than a judgement per call site, since neither has a length it needs.
   *
   * The order matters and is the reason this is one expression rather than two
   * steps in either order. `redactApiKey` masks a literal occurrence of the
   * stored key; capping first can leave the *first half* of that key at the end
   * of the string, which no longer matches and so is not masked. Redacting
   * first and cutting second cannot expose what redaction already replaced.
   */
  private async probeProvider(
    config: { apiUrl: string; apiKey: string; model: string },
    organizationId: string,
    redact: (message: string) => string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const provider = selectAIProvider({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        fetch: this.providerFetch(organizationId),
      });
      const model = provider(config.model);
      const result = await this.generate({
        model,
        prompt: "Reply with 'ok'",
      });
      if (!result.text) {
        throw new Error('No response received from the model');
      }
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      // The guard's own 400, whole: its sentence and `field` are ours, and
      // nothing the target said is in it.
      if (isOutboundAddressRefusal(error)) throw error;
      throw new BadRequestException(
        boundUpstreamMessage(
          redact(
            error instanceof Error
              ? error.message
              : `Connection failed: ${String(error)}`,
          ),
        ),
      );
    }
  }

  /**
   * Lists the provider's models with caller-supplied credentials (nothing
   * stored). Provider quirks are handled per branch — ollama's /api/tags,
   * hardcoded lists for providers without a models endpoint, and the
   * response-shape sniffing chain. Gemini's key-in-query is gone; the
   * key is a header now, and `getProviderHeaders` says why.
   *
   * **Gated, and the `ctx` used to be spelled `_ctx`** — the same
   * finding as `testConnection`, and the sharper half of it: this route fetches
   * the caller's URL directly through `FETCH_CLIENT` and then *answers with
   * what came back*. The success path handed back any array it could find
   * anywhere in the JSON (`Object.values(res).find(Array.isArray)`), and the
   * failure path put `await response.text()` — the target's whole body — into
   * the 400. So the disclosure was not a verdict, it was the response. The
   * answer was that only an owner or admin reaches this and only at a
   * destination `assertDestinationAllowed` permits, and it deliberately left
   * *what comes back* alone.
   *
   * **Both directions are bounded, without dropping either.**
   *
   * - The refusal keeps the provider's words and carries at most
   *   `UPSTREAM_MESSAGE_LIMIT` of them; that constant's docblock is the
   *   argument. The cap sits on this method's own catch rather than on the
   *   `response.text()` two statements below it, because every sentence this
   *   route answers with — the upstream body, a JSON parse failure, an undici
   *   error — leaves through that one `throw`, and a cap per source is a cap a
   *   fourth source is added without.
   * - Every branch of the sniffing chain now goes through `toModels`, so the
   *   answer carries `Model`'s four fields and the only string the target chose
   *   is an `id`. `res.data` used to be handed back *verbatim* — the widest of
   *   the four, since a target controls every field of every element — and
   *   `Object.values(res).find(Array.isArray)` remains the last resort.
   *
   * The chain itself stays, and that is the deliberate half: narrowing it to
   * the two documented shapes (`{ data: [...] }`, `{ models: [...] }`) would
   * refuse a custom OpenAI-compatible endpoint that answers with a bare array
   * or a name of its own, and this route exists to be pointed at those. What is
   * narrowed is the *fields*, which costs nothing — `model-lookup.tsx`
   * renders `model.id` and nothing else, and `endpoints/ai.ts` says so of
   * `AiModel` ("Only `id` reaches the screen"). `created` and `owned_by` are
   * therefore synthesised rather than repeated, which loses a real
   * `owned_by: 'anthropic'` that nothing reads.
   *
   * What that leaves: an array of *many* elements each carrying an `id`, which
   * is a slower channel than the whole body but still one. A count limit was
   * considered and not taken — OpenRouter legitimately lists several hundred
   * models — so it stays a residual rather than a guess at a number.
   *
   * Both gates are outside the `try`, for the reason `testConnection`'s
   * docblock gives: everything inside it comes back out as a 400.
   */
  async getModels(ctx: PermissionCtx, input: GetModelsDto): Promise<Model[]> {
    await this.ensureOwnerOrAdmin(ctx);
    await this.assertDestinationAllowed(ctx, input.apiUrl);
    const fetchModels = this.providerFetch(ctx.session.activeOrganizationId);
    try {
      const providerName = getProviderName(input.apiUrl);
      const headers = getProviderHeaders(input.apiUrl, input.apiKey);
      let response: Response | null = null;
      switch (providerName) {
        case 'ollama':
          response = await fetchModels(`${input.apiUrl}/api/tags`, {
            headers,
          });
          break;
        // The key rides in `headers` like every other provider's. This
        // arm used to spell the URL `…/models?key=<key>` and pass
        // `{ headers: {} }`, discarding `getProviderHeaders`' answer; that
        // function now owns the gemini case and carries the reasoning.
        case 'gemini':
          response = await fetchModels(`${input.apiUrl}/models`, {
            headers,
          });
          break;
        case 'perplexity':
          // Perplexity doesn't have a /models endpoint, return hardcoded list
          return [
            'sonar-deep-research',
            'sonar-reasoning-pro',
            'sonar-reasoning',
            'sonar-pro',
            'sonar',
          ].map((id) => ({
            id,
            object: 'model',
            created: Date.now(),
            owned_by: 'perplexity',
          }));
        case 'zai':
          return ['glm-5', 'glm-4.7'].map((id) => ({
            id,
            object: 'model',
            created: Date.now(),
            owned_by: 'zai',
          }));
        case 'minimax':
          return [
            {
              id: 'MiniMax-M2.7',
              object: 'model',
              created: Date.now(),
              owned_by: 'minimax',
            },
          ];
        default:
          if (!input.apiKey) {
            throw new BadRequestException(
              'API key must contain at least 1 character(s)',
            );
          }
          response = await fetchModels(`${input.apiUrl}/models`, {
            headers,
          });
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch models: ${errorText}`);
      }

      const res = (await response.json()) as
        | Array<{ id?: string; name?: string }>
        | {
            models?: Array<{ id?: string; name?: string }>;
            data?: Model[];
            [key: string]: unknown;
          };

      /**
       * One element of whatever array the sniffing chain settled on, reduced to
       * a `Model`.
       *
       * `typeof … === 'string'` rather than `model.id || model.name || ''`: the
       * two fields are typed `string` because the cast above says so, and a
       * target is under no obligation to agree — an `id` that arrives as an
       * object left this method answering with that object in a field the
       * console prints. An element with neither is dropped by the caller: a
       * model with no name cannot be copied into the Model field, so it is not
       * a model, and dropping it is what makes an array that was never a model
       * list read as "named no models" on screen instead of a row of blanks.
       */
      const toModel = (entry: unknown): Model => {
        const model = (entry ?? {}) as { id?: unknown; name?: unknown };
        const named =
          typeof model.id === 'string'
            ? model.id
            : typeof model.name === 'string'
              ? model.name
              : '';
        return {
          id: named,
          object: 'model',
          created: Date.now(),
          owned_by: 'provider',
        };
      };

      const toModels = (found: readonly unknown[]): Model[] =>
        found.map(toModel).filter((model) => model.id !== '');

      if (Array.isArray(res)) {
        return toModels(res);
      }

      if (res.models) {
        return toModels(res.models);
      }

      if (res.data) {
        return toModels(res.data);
      }

      const possibleModels = Object.values(res).find(Array.isArray) as
        unknown[] | undefined;
      return toModels(possibleModels ?? []);
    } catch (error) {
      if (isOutboundAddressRefusal(error)) throw error;
      throw new BadRequestException(
        boundUpstreamMessage(
          error instanceof Error ? error.message : `Error: ${String(error)}`,
        ),
      );
    }
  }

  /**
   * Instantiates an accepted suggestion as a raw-source compose stack plus its
   * domains and file mounts, riding the same permission/traefik/file-write
   * paths as hand-made services (templates precedent). The created compose
   * row is returned, and a serverId is org-scoped through ServersService.
   *
   * **Every refusal this method can give is now given before its first write.**
   * The compose insert, the grant and the two population loops are
   * not one transaction and nothing scopes them to each other, so a refusal
   * *inside* a loop left the caller owning a stack with some or none of its
   * config files and no cleanup ran — an earlier regression made exactly that
   * shape live before `a73a43c` removed its cause. The blueprint-level facts
   * were already hoisted here (`hostSchema` and `filePathSchema` on
   * `deployAiSchema`; `assertHostsUnclaimed`); the last of it
   * was the statements the loops claim, which
   * {@link composedCreateStatements} now claims at the pre-flight.
   * Its sibling was the `template.toml` deploy, removed in #1364; a
   * Template's compose part is now made by `PlanApplier.createTemplateStack`,
   * which deletes its row again when a later write fails. This route does
   * not compensate for a mid-loop *infrastructure* failure that way yet.
   */
  async deploy(ctx: PermissionCtx, input: DeployAiDto) {
    const parent = await this.findParentEnvironment(ctx, input.environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');

    if (input.serverId) {
      await this.servers.findOne(ctx, input.serverId);
    }

    // Every statement the two loops below are going to claim, claimed here
    // instead of there — as `PlanApplier.check` does for a Template's parts;
    // see `composedCreateStatements` for the list and for why they are
    // separate calls. Above
    // `assertHostsUnclaimed` because a caller who may not attach a domain must
    // not learn from that check that some other organization holds the
    // hostname: it is the role half, it reads nothing, and a Template's setup
    // and Apply put the role question ahead of the lookup on the same argument.
    for (const statement of composedCreateStatements({
      domains: input.domains?.length ?? 0,
      mounts: input.configFiles?.length ?? 0,
    })) {
      await this.permissions.checkPermission(ctx, statement);
    }

    // The hostname *ownership* rule, at the pre-flight seam rather than only
    // inside the domains loop below (as the removed `template.toml` deploy
    // had it). That loop reaches the
    // transaction-guarded check inside `DomainsService.create`, which stays the
    // authority — but it runs after the stack exists, so on its own it refused
    // a squatted hostname by leaving an orphan compose row behind. That was
    // closed for the old templates deploy route and this sibling was missed; the
    // `DeployAiDto` docblock recorded only that the ownership check "does apply
    // already", which was true and late.
    //
    // Safe here because the two lines above have authorized the environment and
    // the Server, which is the precondition `assertHostsUnclaimed` states: it
    // answers about *other* organizations' rows. `hostSchema` on
    // `deployAiSchema.domains[].host` has already narrowed each host's charset.
    //
    // The *routing* rule goes first, as it does inside `create` and in a
    // Template's Apply (`taken-template-hosts.ts`): `DomainsService`'s own
    // `(host, path)` predicate,
    // which otherwise fired only in the loop below and left the stack built.
    // This body carries no `path`, so each entry is a router at `/` — exactly
    // what `create` defaults it to — and two entries naming one host are
    // refused here too, rather than by the second insert.
    await this.domains.assertRoutesUntaken(
      ctx,
      input.domains?.map((requested) => ({ host: requested.host })) ?? [],
    );
    await this.domains.assertHostsUnclaimed(
      ctx,
      input.domains?.map((requested) => requested.host) ?? [],
      input.serverId ?? null,
    );

    const projectName = slugify(`${parent.projectName} ${input.id}`);

    const compose = await this.compose.createByTemplate({
      environmentId: input.environmentId,
      composeFile: input.dockerCompose,
      env: input.envVariables,
      serverId: input.serverId,
      name: input.name,
      description: input.description,
      sourceType: 'raw',
      appName: `${projectName}-${generatePassword(6)}`,
      isolatedDeployment: true,
    });

    // Before the domains and mounts loops, not after them, for this reason:
    // both
    // `DomainsService.create` and `MountsService.create` run
    // `checkServiceAccess` against this stack, and the row-level half of that
    // check reads `accessedServices` — which this call is what writes. Granting
    // last made the route unusable for any caller who does not skip the
    // row-level check, i.e. everyone but owner and admin: a custom role
    // holding `service:['create']` had its own one-statement-old stack refused
    // to it, and the ungranted orphan left behind was then beyond its reach.
    await this.permissions.addNewService(ctx, compose.composeId);

    if (input.domains && input.domains.length > 0) {
      for (const domain of input.domains) {
        await this.domains.create(ctx, {
          ...domain,
          domainType: 'compose',
          certificateType: 'none',
          composeId: compose.composeId,
        });
      }
    }

    if (input.configFiles && input.configFiles.length > 0) {
      for (const mount of input.configFiles) {
        // No `mountPath`: a compose file mount has no container target to name,
        // and the DTO says so now rather than each caller writing `''` past a
        // field its own schema called required. The stored value is
        // still `''` — `MountsService` applies it for the NOT NULL column.
        //
        // `createForNewService`, not `create`: this stack is one statement old
        // and the `checkServiceAccess(projectId, 'create')` above authorized
        // building it, mounts and all. `POST /mounts` asks for
        // `service: ['update']` because it edits a definition somebody else's
        // statement built; there is no previous definition here to edit. See
        // that method's docblock — sending this through `create` refused a
        // `service: ['create', 'read']` role its own config files with the
        // compose row already committed.
        await this.mounts.createForNewService(ctx, {
          filePath: mount.filePath,
          content: mount.content,
          serviceId: compose.composeId,
          serviceType: 'compose',
          type: 'file',
        });
      }
    }

    return compose;
  }

  /** The environment (with its project) inside the caller's organization. */
  private async findParentEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
  ) {
    const [found] = await this.db
      .select({
        environmentId: environment.environmentId,
        projectId: environment.projectId,
        projectName: project.name,
      })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }

  private async listRows(ctx: PermissionCtx): Promise<Ai[]> {
    return this.db
      .select()
      .from(ai)
      .where(eq(ai.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(ai.createdAt));
  }

  /**
   * The full row including the decrypted apiKey, for internal use (provider
   * selection). Never returned from a controller. Org-scoped like every lookup
   * here (registries precedent): an id from another organization is a 404.
   */
  async findOneWithCredentials(ctx: PermissionCtx, aiId: string): Promise<Ai> {
    const [found] = await this.db
      .select()
      .from(ai)
      .where(
        and(
          eq(ai.aiId, aiId),
          eq(ai.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('AI settings not found');
    return found;
  }
}
