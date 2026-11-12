import 'reflect-metadata';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { BaseDatabaseService } from '../../src/databases/common/database-service';
import { routesOf } from '../../src/mcp/tool-definition';
import { MCP_TOOLS } from '../../src/mcp/tools';

/**
 * The console Saves seam's entry points: every write of a Service's
 * settings, and every create and Delete, goes through one of these, which
 * is where a repository-kept config's refusals are made.
 */
const SAVES = new Set([
  'create',
  'createByTemplate',
  'update',
  'saveEnvironment',
  'uploadDrop',
  'remove',
]);

function isServiceKind(service: unknown): boolean {
  return (
    service === ApplicationsService ||
    service === ComposeService ||
    (typeof service === 'function' &&
      service.prototype instanceof BaseDatabaseService)
  );
}

/**
 * US71: an Agent cannot get past a repository-kept config. Today no MCP tool
 * writes a Service's settings, creates one or deletes one at all (agent roles
 * hold no Service write), so there is nothing to refuse there. This
 * holds that, so the first tool that does is a decision: it must target the
 * same service method the console does, which carries the refusal, and
 * declare the refusal (`PROJECT_CONFIG_REPOSITORY_KEPT`) in its error table.
 */
describe('MCP_TOOLS', () => {
  it('has no tool that creates, writes the settings of, or deletes a Service', () => {
    const onServices = MCP_TOOLS.flatMap((tool) =>
      routesOf(tool).filter(({ route }) => isServiceKind(route.target.service)),
    );
    const writes = onServices
      .filter(({ route }) => SAVES.has(route.target.method))
      .map(({ label }) => label);

    // Not vacuous: start_service and stop_service call these services.
    expect(onServices.length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
  });
});
