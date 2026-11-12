import { rawStrategy } from '../../src/git-providers/strategies/raw.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('rawStrategy.cloneProgram', () => {
  it('materializes the content as a base64-decoded docker-compose.yml', () => {
    const { command } = rawStrategy.cloneProgram({
      outputPath: '/stacks/blog/code',
      content: 'hello',
    });

    // 'aGVsbG8=' is base64 for 'hello'
    expect(command).toBe(
      `set -e;
rm -rf /stacks/blog/code;
mkdir -p /stacks/blog/code;
echo "aGVsbG8=" | base64 -d > /stacks/blog/code/docker-compose.yml;
echo "File 'docker-compose.yml' created: ✅";`,
    );
  });

  it('writes to a custom file name when given one', () => {
    const { command } = rawStrategy.cloneProgram({
      outputPath: '/stacks/blog/code',
      content: 'hello',
      fileName: 'stack.yml',
    });

    expect(command).toContain(
      'echo "aGVsbG8=" | base64 -d > /stacks/blog/code/stack.yml;',
    );
    expect(command).toContain(`echo "File 'stack.yml' created: ✅";`);
  });
});

describe('rawStrategy branches/commits', () => {
  it('has no branches or commit info', () => {
    expect(rawStrategy.listBranches({})).toBeNull();
    expect(rawStrategy.getCommitInfo({ outputPath: '/x' })).toBeNull();
  });
});

describe('rawStrategy shell safety', () => {
  // The content is base64'd, but the path it lands on and the `rm -rf`
  // target were bare words — and `fileName` comes from the row's `composePath`.
  it('quotes the output path and the file name', () => {
    const { command } = rawStrategy.cloneProgram({
      outputPath: `/stacks/${SHELL_PAYLOAD}/code`,
      content: 'hello',
      fileName: `${SHELL_PAYLOAD}.yml`,
    });

    expectQuotedInCommand(command);
    expect(command).toContain('rm -rf');
    expect(command).toContain('base64 -d');
  });
});
