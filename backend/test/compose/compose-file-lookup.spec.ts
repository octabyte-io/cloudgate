import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPOSE_FILE_NAMES,
  composeFileLookupCommand,
  composeFileLookupLogLine,
  composeFileNotFoundMessage,
  findComposeFile,
} from '../../src/compose/compose-file-lookup';

/**
 * ADR-0091: a Compose Service with no file named finds it in its clone, in
 * Docker's own order. The lookup's program runs under a real `sh` over a real
 * folder, so what is tested is what a deploy runs.
 */
describe('findComposeFile', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'compose-lookup-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** Lays `names` out in the folder and runs the lookup there. */
  function lookUp(...names: string[]) {
    for (const name of names)
      writeFileSync(join(folder, name), 'services: {}\n');
    const stdout = execFileSync(
      'sh',
      ['-c', composeFileLookupCommand(folder)],
      {
        encoding: 'utf8',
      },
    );
    return findComposeFile(stdout);
  }

  it('looks for Docker’s four names, in Docker’s order', () => {
    expect(COMPOSE_FILE_NAMES).toEqual([
      'compose.yaml',
      'compose.yml',
      'docker-compose.yaml',
      'docker-compose.yml',
    ]);
  });

  it.each([
    'compose.yaml',
    'compose.yml',
    'docker-compose.yaml',
    'docker-compose.yml',
  ])('finds %s when it is the only one', (name) => {
    expect(lookUp(name, 'README.md')).toEqual({ file: name, others: [] });
  });

  it('uses compose.yaml over every other name, and names the others', () => {
    expect(
      lookUp(
        'docker-compose.yml',
        'compose.yml',
        'docker-compose.yaml',
        'compose.yaml',
      ),
    ).toEqual({
      file: 'compose.yaml',
      others: ['compose.yml', 'docker-compose.yaml', 'docker-compose.yml'],
    });
  });

  it('uses compose.yml over the docker-compose names', () => {
    expect(lookUp('docker-compose.yml', 'compose.yml')).toEqual({
      file: 'compose.yml',
      others: ['docker-compose.yml'],
    });
  });

  it('uses docker-compose.yaml over docker-compose.yml', () => {
    expect(lookUp('docker-compose.yml', 'docker-compose.yaml')).toEqual({
      file: 'docker-compose.yaml',
      others: ['docker-compose.yml'],
    });
  });

  it('finds nothing in a folder holding none of the four', () => {
    expect(lookUp('README.md', 'compose.json')).toBeNull();
  });

  it('does not take a folder with a compose name for a file', () => {
    mkdirSync(join(folder, 'compose.yaml'));
    expect(lookUp('docker-compose.yml')).toEqual({
      file: 'docker-compose.yml',
      others: [],
    });
  });

  it('finds nothing, and exits 0, where the folder does not exist', () => {
    const stdout = execFileSync(
      'sh',
      ['-c', composeFileLookupCommand(join(folder, 'missing'))],
      { encoding: 'utf8' },
    );
    expect(findComposeFile(stdout)).toBeNull();
  });

  it('reads a folder whose name needs quoting', () => {
    const odd = join(folder, "it's $HOME; here");
    mkdirSync(odd);
    writeFileSync(join(odd, 'compose.yml'), 'services: {}\n');
    const stdout = execFileSync('sh', ['-c', composeFileLookupCommand(odd)], {
      encoding: 'utf8',
    });
    expect(findComposeFile(stdout)).toEqual({
      file: 'compose.yml',
      others: [],
    });
  });
});

describe('composeFileLookupLogLine', () => {
  it('names the file used', () => {
    expect(composeFileLookupLogLine({ file: 'compose.yaml', others: [] })).toBe(
      'No compose file named: using compose.yaml',
    );
  });

  it('names the file used and the others also there', () => {
    expect(
      composeFileLookupLogLine({
        file: 'compose.yaml',
        others: ['docker-compose.yml'],
      }),
    ).toBe(
      'No compose file named: using compose.yaml (also present, not used: docker-compose.yml)',
    );
  });
});

describe('composeFileNotFoundMessage', () => {
  it('names all four names', () => {
    expect(composeFileNotFoundMessage()).toBe(
      'No compose file named, and none found: looked for compose.yaml, compose.yml, docker-compose.yaml and docker-compose.yml',
    );
  });
});
