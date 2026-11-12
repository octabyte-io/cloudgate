import { quote } from 'shell-quote';
import { pushProgram } from '../../src/project-config/applier/cloud-deploy-steps';

/**
 * The push removes only what its deploy owns: the `remote` tag it
 * made, and the build output of its own Application. A docker source's
 * image is the operator's own reference, which another Service of the same
 * Apply may have pulled and still be about to inspect.
 */
describe('pushProgram', () => {
  const place = {
    registry: '123.dkr.ecr.us-east-1.amazonaws.com',
    username: 'AWS',
    remote: '123.dkr.ecr.us-east-1.amazonaws.com/cg-app:dep1',
    logPath: '/logs/app/dep1.log',
  };

  function removed(program: string): string {
    const line = program.split('\n').find((l) => l.includes('docker image rm'));
    if (!line) throw new Error('the program removes nothing');
    return line;
  }

  it("does not remove a docker source's image, which other Services may share", () => {
    const program = pushProgram({
      ...place,
      app: {
        sourceType: 'docker',
        dockerImage: 'busybox:1.36',
        appName: 'ticker',
      },
    });

    expect(program).toContain(`docker tag ${quote(['busybox:1.36'])} `);
    expect(removed(program)).toContain(quote([place.remote]));
    expect(removed(program)).not.toContain(quote(['busybox:1.36']));
  });

  it('removes the remote tag and the build output of a built image', () => {
    const program = pushProgram({
      ...place,
      app: { sourceType: 'git', dockerImage: null, appName: 'web-abc' },
    });

    expect(program).toContain(`docker tag ${quote(['web-abc:latest'])} `);
    expect(removed(program)).toContain(quote([place.remote]));
    expect(removed(program)).toContain(quote(['web-abc:latest']));
  });
});
