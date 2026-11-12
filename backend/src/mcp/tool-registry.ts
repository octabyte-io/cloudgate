import { z } from 'zod';
import { encryptedColumnNames } from './secret-mask';
import { ROW_SCOPED, routesOf } from './tool-definition';
import type {
  AnyTool,
  KindRoutedTool,
  ToolPermissions,
} from './tool-definition';
import { assertProjection } from './tool-projection';

/**
 * The tools the endpoint serves, **fail closed** (ADR-0023).
 *
 * Constructing a registry checks every declaration and throws on the first
 * bad one, and `McpModule` constructs it as a provider, so a malformed tool
 * stops the process at boot rather than serving something half-declared:
 *
 * - no permission declaration (neither statements nor {@link ROW_SCOPED});
 * - an empty statement map, which `checkPermission` would pass for anyone;
 * - a twin, target, audit vocabulary, projection or error table missing —
 *   on a kind-taking tool, on any of its routes;
 * - a kind-taking tool whose routes are not exactly its kind enum's values;
 * - a projection that fails `assertProjection`;
 * - a `targetId` that is not one of the tool's input fields;
 * - two tools of one name.
 *
 * And at dispatch {@link ToolRegistry.permissionsOf} asks again, so a tool
 * that reached the dispatcher some other way is refused rather than run.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[]) {
    const secretNames = encryptedColumnNames();
    for (const tool of tools) {
      const fail = (why: string): never => {
        throw new Error(
          `MCP tool ${tool?.name ?? '(unnamed)'} refused to register: ${why}`,
        );
      };
      if (!tool?.name) fail('it has no name');
      if (this.byName.has(tool.name))
        fail('a tool of that name is already registered');
      if (!declaredPermissions(tool)) fail('it declares no permissions');
      if (tool.routes !== undefined) checkKindRoutes(tool, fail);
      for (const { label, route } of routesOf(tool)) {
        if (!route?.twin?.controller || !route.twin.handler)
          fail(`${label} names no HTTP twin`);
        if (!route.target?.service || !route.target.method)
          fail(`${label} names no service method`);
        if (typeof route.call !== 'function') fail(`${label} has no call`);
      }
      if (
        tool.join !== undefined &&
        (!tool.join.target?.service ||
          !tool.join.target.method ||
          typeof tool.join.call !== 'function')
      ) {
        fail('its join names no service method or has no call');
      }
      if (!tool.audit?.resourceType || !tool.audit.action)
        fail('it declares no audit vocabulary');
      if (!tool.projection) fail('it declares no projection');
      if (!Array.isArray(tool.errors)) fail('it declares no error table');
      if (typeof tool.maskRoots !== 'function')
        fail('it declares no mask roots');
      if (tool.targetId !== undefined && !(tool.targetId in tool.input.shape)) {
        fail(`its targetId "${tool.targetId}" is not an input field`);
      }
      assertProjection(tool.name, tool.projection, secretNames);
      this.byName.set(tool.name, tool);
    }
  }

  /** Every registered tool, in registration order. */
  all(): AnyTool[] {
    return [...this.byName.values()];
  }

  get(name: string): AnyTool | undefined {
    return this.byName.get(name);
  }

  /** A tool's declaration, re-checked at dispatch; throws when it has none. */
  permissionsOf(tool: AnyTool): ToolPermissions {
    const declared = declaredPermissions(tool);
    if (!declared)
      throw new Error(`MCP tool ${tool.name} declares no permissions`);
    return declared;
  }
}

/**
 * A kind-taking tool's routes are exactly the values of its `routedBy` enum:
 * a kind with no route would be a valid argument that nothing answers, and a
 * route no argument can reach is a twin the census checks for nothing.
 */
function checkKindRoutes(
  tool: KindRoutedTool,
  fail: (why: string) => never,
): void {
  const field: unknown = tool.input.shape[tool.routedBy];
  if (!(field instanceof z.ZodEnum)) {
    fail(`its routedBy "${tool.routedBy}" is not an enum input field`);
  }
  const kinds = [...field.options].map(String).sort();
  const routed = Object.keys(tool.routes).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(routed)) {
    fail(
      `its routes (${routed.join(', ')}) are not the values of "${tool.routedBy}" (${kinds.join(', ')})`,
    );
  }
}

/** The declaration when it is one the dispatcher can check, else `null`. */
function declaredPermissions(tool: AnyTool): ToolPermissions | null {
  const declared = tool.permissions as ToolPermissions | undefined;
  if (declared === ROW_SCOPED) return declared;
  if (!declared || typeof declared !== 'object') return null;
  const statements = Object.values(declared);
  if (statements.length === 0) return null;
  if (
    statements.some(
      (actions) => !Array.isArray(actions) || actions.length === 0,
    )
  ) {
    return null;
  }
  return declared;
}
