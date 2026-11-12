import type { CreateServiceOptions } from 'dockerode';
import { ForwardAuthProxyService } from '../../../src/enterprise/forward-auth/forward-auth-proxy.service';
import type { RemoteDockerFactory } from '../../../src/docker/remote-docker.factory';

/**
 * The proxy's service spec, asserted the way `mechanize.spec.ts` asserts an
 * Application's: a fake daemon whose `createService` records what it was handed.
 * `setup()` inspects first and creates only when the inspect throws, so a
 * rejecting inspect is what puts it on the create branch.
 */
const makeDocker = () => {
  const service = {
    inspect: jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValue(new Error('no such service')),
    update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(undefined),
  };
  const docker = {
    getService: jest.fn(() => service),
    createService: jest
      .fn<Promise<unknown>, [CreateServiceOptions]>()
      .mockResolvedValue(undefined),
  };
  return { docker, service };
};

const options = {
  oidc: {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    issuer: 'https://idp.example.com',
  },
  cookieSecret: '0123456789abcdef',
  authDomain: 'auth.example.com',
  baseDomain: '.example.com',
};

describe('ForwardAuthProxyService.setup', () => {
  // This was the last container Cloudgate creates with no log ceiling, and
  // the one most likely to need one — oauth2-proxy exits non-zero on bad
  // configuration and Swarm restarts it, so a misconfigured provider is a crash
  // loop writing its whole startup log once per restart, unbounded.
  it('bounds the proxy’s log, which a crash loop would otherwise fill a disk with', async () => {
    const { docker } = makeDocker();
    const service = new ForwardAuthProxyService({
      getRemoteDocker: jest.fn().mockResolvedValue(docker),
    } as unknown as RemoteDockerFactory);

    await service.setup(options);

    const [settings] = docker.createService.mock.calls[0];
    expect(settings.TaskTemplate?.LogDriver).toEqual({
      Name: 'json-file',
      Options: { 'max-size': '10m', 'max-file': '3' },
    });
  });

  // The ceiling is a sibling of Networks and Placement; nothing it sits beside
  // moved, and the manager constraint in particular is load-bearing.
  it('still pins the proxy to a manager node on the overlay network', async () => {
    const { docker } = makeDocker();
    const service = new ForwardAuthProxyService({
      getRemoteDocker: jest.fn().mockResolvedValue(docker),
    } as unknown as RemoteDockerFactory);

    await service.setup(options);

    const [settings] = docker.createService.mock.calls[0];
    expect(settings.TaskTemplate?.Placement?.Constraints).toEqual([
      'node.role==manager',
    ]);
    expect(settings.TaskTemplate?.Networks).toEqual([
      { Target: 'cloudgate-network' },
    ]);
  });
});
