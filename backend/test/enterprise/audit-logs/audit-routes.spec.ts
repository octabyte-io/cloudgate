import { auditTargetFor } from '../../../src/enterprise/audit-logs/audit-routes';

describe('auditTargetFor', () => {
  it.each([
    // The five deletes the audit ticket names: each writes a row naming the resource.
    ['DELETE', '/applications/:id', 'application', 'delete'],
    ['DELETE', '/postgres/:id', 'database', 'delete'],
    ['DELETE', '/servers/:id', 'server', 'delete'],
    ['DELETE', '/domains/:id', 'domain', 'delete'],
    ['DELETE', '/destinations/:id', 'destination', 'delete'],
    // A collection POST creates; a typed collection under one creates too.
    ['POST', '/projects', 'project', 'create'],
    ['POST', '/notifications/slack', 'notification', 'create'],
    // A named verb is the action.
    [
      'POST',
      '/applications/:applicationId/deployments',
      'application',
      'deploy',
    ],
    ['POST', '/deployments/:deploymentId/cancel', 'deployment', 'cancel'],
    ['POST', '/deployments/:deploymentId/stop-run', 'deployment', 'stop'],
    ['POST', '/mysql/:id/rebuild', 'database', 'rebuild'],
    ['POST', '/docker/containers/:containerId/kill', 'docker', 'kill'],
    // Anything else under an existing row changes it.
    ['POST', '/applications/:id/refresh-token', 'application', 'update'],
    ['PATCH', '/compose/:id/environment', 'compose', 'update'],
    // Settings are changed, never created.
    ['POST', '/settings/ip', 'settings', 'update'],
    // Overrides.
    ['POST', '/users/me/sessions/revoke', 'session', 'delete'],
  ])('%s %s records %s %s', (method, path, resourceType, action) => {
    expect(auditTargetFor(method, path)).toEqual({ resourceType, action });
  });

  it.each([
    // Reads, probes, and routes whose service writes its own entry.
    ['GET', '/applications/:id'],
    ['POST', '/destinations/:id/test-connection'],
    ['POST', '/ai/suggest'],
    ['DELETE', '/organizations/:id'],
    ['POST', '/users/me/api-keys'],
    // A segment nobody mapped.
    ['POST', '/nowhere'],
  ])('%s %s records nothing', (method, path) => {
    expect(auditTargetFor(method, path)).toBeNull();
  });
});
