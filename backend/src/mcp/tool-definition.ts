import type { Type } from '@nestjs/common';
import type { z } from 'zod';
import type {
  AuditAction,
  AuditResourceType,
} from '../enterprise/audit-logs/audit-log.schema';
import type { PermissionCtx, Permissions } from '../rbac/permission.service';
import type { BucketBudget } from './rate-bucket';
import type { SecretRoot } from './secret-mask';
import type { ErrorTable } from './tool-errors';
import type { Projection } from './tool-projection';

/**
 * One MCP tool, declared as data (ADR-0023, ADR-0024).
 *
 * Everything the dispatcher does with a tool is read off this declaration,
 * and everything here is checked twice — at boot by `ToolRegistry`, which
 * refuses to start on a missing or malformed part, and in the coding-standards
 * censuses, which hold each part to the thing it claims to mirror:
 *
 * | part          | census                                  |
 * | ------------- | --------------------------------------- |
 * | `permissions`, `twin`, `target`, `join` | `tool-permissions.spec.ts` |
 * | `projection`  | `tool-projections.spec.ts`              |
 * | `errors`      | `tool-error-tables.spec.ts`             |
 * | `maskRoots`   | `tool-secret-mask.spec.ts`              |
 *
 * To add a tool: declare it with {@link defineTool} in a file
 * under `src/mcp/tools/`, append it to `MCP_TOOLS` in `tools/index.ts`, import
 * the module that provides its service into `McpModule`, and add it to the
 * censuses' frozen lists — the tool count and the no-twin count are frozen
 * (ADR-0023), so a new tool is an argued edit, not a quiet one.
 *
 * A tool taking a Service `kind` (`get_service`, `start_service`)
 * declares a twin, target and call per kind instead of one — `routedBy` plus
 * `routes`, see {@link KindRoutedTool} and {@link kindRoute}.
 */

/**
 * A tool whose twin declares no statement and filters rows by the member's
 * grant columns instead (`list_projects`, `list_environments`). Spelled out,
 * never implied by an absent `permissions`: an absent declaration refuses to
 * register (fail closed, ADR-0023).
 */
export const ROW_SCOPED = 'row-scoped';

export type ToolPermissions = Permissions | typeof ROW_SCOPED;

/**
 * The HTTP route the tool mirrors. `tool-permissions.spec.ts` reflects the
 * route and its `@RequirePermission` off `controller.prototype[handler]`.
 */
export interface ToolTwin {
  readonly controller: Type<unknown>;
  readonly handler: string;
  /**
   * For a **read** twin carrying no `@RequirePermission` — every `GET` in
   * this tree, since `route-permissions.spec.ts`'s `BASELINE` lists only
   * mutating handlers — the in-service call that enforces the same statement:
   * the file, the method whose body makes the call, and the call as written.
   * The census reads the method out of the file and checks the call is there
   * and that it asks for exactly the tool's `permissions`.
   */
  readonly enforcedIn?: {
    readonly file: string;
    readonly method: string;
    readonly check: string;
  };
}

/** The audit vocabulary of a tool's rows: its twin's. */
export interface ToolAudit {
  readonly resourceType: AuditResourceType;
  readonly action: AuditAction;
}

/**
 * One twin, the service method mirroring it, and how the tool calls it. A
 * plain tool is one route; a tool taking a Service `kind` is one route
 * per kind — see {@link KindRoutedTool}.
 */
export interface ToolRoute<
  Service = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
> {
  readonly twin: ToolTwin;
  /** The service method called — never a controller — which takes `ctx` first. */
  readonly target: { readonly service: Type<Service>; readonly method: string };
  readonly call: (
    service: Service,
    ctx: PermissionCtx,
    args: z.infer<Input>,
  ) => Promise<Raw>;
}

/** A route of a kind-taking tool, which may carry its own twin's audit kind. */
export interface KindRoute<
  Service = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
> extends ToolRoute<Service, Input, Raw> {
  /**
   * The audit vocabulary when this kind's twin writes another resource type
   * than the tool's `audit` — `get_service` on a database is a `database`
   * row, as `GET /postgres/:id` would be.
   */
  readonly audit?: ToolAudit;
}

/**
 * A second read joined onto a route's answer: `get_service`'s open
 * Incidents, which no kind's `findOne` carries, and `get_environment`'s
 * open-Incident counts.
 * It runs only after the route's call answered, and its method takes `ctx`
 * first and gates itself — `tool-permissions.spec.ts` holds it to that as it
 * does a route's target — so a join can add to an answer but never widen who
 * gets one. Its output leaves only through the tool's projection.
 */
export interface ToolJoin<
  Service = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
> {
  readonly target: { readonly service: Type<Service>; readonly method: string };
  readonly call: (
    service: Service,
    ctx: PermissionCtx,
    args: z.infer<Input>,
    raw: Raw,
  ) => Promise<Raw>;
}

/** Declares a join with its service type tied to its call. */
export function toolJoin<Service, Input extends z.ZodObject, Raw>(
  _input: Input,
  join: ToolJoin<Service, Input, Raw>,
): ToolJoin<Service, Input, Raw> {
  return join;
}

interface ToolCommon<Input extends z.ZodObject, Raw> {
  readonly name: string;
  readonly title: string;
  /** What the agent reads in `tools/list`. */
  readonly description: string;
  /** `read` is annotated read-only and spends the read budget; `write` the write budget. */
  readonly kind: BucketBudget;
  readonly input: Input;
  /** Mandatory. Identical to the twin's, or {@link ROW_SCOPED}. */
  readonly permissions: ToolPermissions;
  /**
   * The declared id argument naming the tool's target. Its value becomes the
   * audit row's `resourceId` — the only place a row's target id comes from.
   * A tool with one is *id-addressed*, and its `errors` must map its target's
   * 404 and every `*_ACCESS_NOT_GRANTED` to `grant`.
   */
  readonly targetId?: keyof z.infer<Input> & string;
  /** The twin's audit vocabulary; `metadata.tool` replaces `metadata.route`. */
  readonly audit: ToolAudit;
  readonly projection: Projection;
  readonly errors: ErrorTable;
  /** The rows the mask walks from, given the arguments and the raw result. */
  readonly maskRoots: (args: z.infer<Input>, raw: Raw) => SecretRoot[];
  /** A second, self-gated read joined onto every route's answer. */
  readonly join?: ToolJoin<any, Input, Raw>;
  /**
   * What a *succeeded* call's row adds to its `metadata`, beside `tool` and
   * `credential` — `deploy_service`'s `coalesced` and `mode`. Read off
   * the arguments and the raw result, so it says what happened rather than
   * what was asked; never a value the projection would not let out.
   */
  readonly auditDetail?: (
    args: z.infer<Input>,
    raw: Raw,
  ) => Readonly<Record<string, string | number | boolean | null>>;
}

/** A tool with one twin and one service method. */
export interface SingleRouteTool<
  Service = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
>
  extends ToolCommon<Input, Raw>, ToolRoute<Service, Input, Raw> {
  readonly routedBy?: undefined;
  readonly routes?: undefined;
}

/**
 * A tool taking a Service `kind`: one concept, with a twin and a
 * service method per kind — `get_service` is `GET /applications/:id` for an
 * Application and `GET /postgres/:id` for a Postgres. `routedBy` names the
 * input field, a `z.enum`, whose value picks the route; `ToolRegistry`
 * refuses a tool whose routes are not exactly that enum's values. Every route
 * answers under the tool's one `permissions`, which `tool-permissions.spec.ts`
 * holds to each route's twin.
 */
export interface KindRoutedTool<
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
> extends ToolCommon<Input, Raw> {
  readonly routedBy: keyof z.infer<Input> & string;
  /** One route per value of the `routedBy` enum; each names its own service. */
  readonly routes: Readonly<Record<string, KindRoute<any, Input, Raw>>>;
  readonly twin?: undefined;
  readonly target?: undefined;
  readonly call?: undefined;
}

export type ToolDefinition<
  Service = unknown,
  Input extends z.ZodObject = z.ZodObject,
  Raw = unknown,
> = SingleRouteTool<Service, Input, Raw> | KindRoutedTool<Input, Raw>;

/** A tool of any service and shape, as the registry and dispatcher hold it. */
export type AnyTool = ToolDefinition<any, z.ZodObject, any>;

/** A route of any service and shape. */
export type AnyRoute = KindRoute<any, z.ZodObject, any>;

/** Declares a tool with its types tied together; the value is the declaration. */
export function defineTool<Service, Input extends z.ZodObject, Raw>(
  tool: SingleRouteTool<Service, Input, Raw>,
): SingleRouteTool<Service, Input, Raw>;
export function defineTool<Input extends z.ZodObject, Raw>(
  tool: KindRoutedTool<Input, Raw>,
): KindRoutedTool<Input, Raw>;
export function defineTool(tool: AnyTool): AnyTool {
  return tool;
}

/**
 * Declares one kind's route with its service type tied to its call. `input`
 * is the tool's input schema, passed only so `args` is typed.
 */
export function kindRoute<Service, Input extends z.ZodObject, Raw>(
  _input: Input,
  route: KindRoute<Service, Input, Raw>,
): KindRoute<Service, Input, Raw> {
  return route;
}

/** Every route a tool declares, labelled `tool` or `tool[kind]` for a census. */
export function routesOf(
  tool: AnyTool,
): Array<{ label: string; route: AnyRoute }> {
  if (tool.routes === undefined) return [{ label: tool.name, route: tool }];
  return Object.entries(tool.routes).map(([kind, route]) => ({
    label: `${tool.name}[${kind}]`,
    route,
  }));
}

/**
 * The route a call takes: the tool itself, or the route its kind argument
 * names. `undefined` only for arguments the input schema refuses.
 */
export function routeFor(
  tool: AnyTool,
  args: Record<string, unknown>,
): AnyRoute | undefined {
  if (tool.routes === undefined) return tool;
  const kind = args[tool.routedBy];
  return typeof kind === 'string' && Object.hasOwn(tool.routes, kind)
    ? tool.routes[kind]
    : undefined;
}

/** The audit vocabulary of a call's row: its route's, else the tool's. */
export function auditOf(
  tool: AnyTool,
  args: Record<string, unknown>,
): ToolAudit {
  return routeFor(tool, args)?.audit ?? tool.audit;
}
