import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import { findNearestLink, removeLink, writeLink } from '../src/folder-link.js';
import type { FolderLink } from '../src/folder-link.js';

const shopApi: FolderLink = {
  instance: 'https://cloudgate.octabyte.app',
  organizationId: 'org_1',
  projectId: 'prj_1',
  environmentId: 'env_staging',
  serviceConfigName: 'api',
  names: {
    organization: 'Shop Inc',
    project: 'shop',
    environment: 'staging',
    service: 'api',
  },
};

const shopWeb: FolderLink = {
  ...shopApi,
  serviceConfigName: 'web',
  names: { ...shopApi.names, service: 'web' },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudgate-link-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('writeLink', () => {
  it('saves .cloudgate/link.json, which findNearestLink reads back', () => {
    writeLink(root, shopApi);

    expect(
      JSON.parse(readFileSync(join(root, '.cloudgate', 'link.json'), 'utf8')),
    ).toMatchObject({
      instance: 'https://cloudgate.octabyte.app',
      organizationId: 'org_1',
      projectId: 'prj_1',
      environmentId: 'env_staging',
      serviceConfigName: 'api',
    });
    expect(findNearestLink(root)).toEqual({
      folder: root,
      file: join(root, '.cloudgate', 'link.json'),
      link: shopApi,
    });
  });

  it('creates a .gitignore holding .cloudgate/ when there is none', () => {
    writeLink(root, shopApi);

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      '.cloudgate/\n',
    );
  });

  it('appends .cloudgate/ to an existing .gitignore, keeping what it held', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist');

    writeLink(root, shopApi);

    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules\ndist\n.cloudgate/\n',
    );
  });

  it('leaves a .gitignore that already ignores .cloudgate alone', () => {
    for (const line of ['.cloudgate/', '.cloudgate', '/.cloudgate/']) {
      writeFileSync(join(root, '.gitignore'), `dist\n${line}\n`);

      writeLink(root, shopApi);

      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
        `dist\n${line}\n`,
      );
    }
  });

  it('replaces the link a folder already holds', () => {
    writeLink(root, shopApi);
    writeLink(root, shopWeb);

    expect(findNearestLink(root)?.link.serviceConfigName).toBe('web');
  });
});

describe('findNearestLink', () => {
  it('finds nothing when no folder at or above holds a link', () => {
    expect(findNearestLink(root)).toBeUndefined();
  });

  it('uses the nearest link above, from a subfolder', () => {
    writeLink(root, shopApi);
    const deep = join(root, 'src', 'routes');
    mkdirSync(deep, { recursive: true });

    expect(findNearestLink(deep)).toMatchObject({
      folder: root,
      link: { serviceConfigName: 'api' },
    });
  });

  it("lets each subfolder's own link win in a monorepo", () => {
    const api = join(root, 'apps', 'api');
    const web = join(root, 'apps', 'web');
    mkdirSync(join(api, 'src'), { recursive: true });
    mkdirSync(web, { recursive: true });
    writeLink(root, { ...shopApi, serviceConfigName: 'root' });
    writeLink(api, shopApi);
    writeLink(web, shopWeb);

    expect(findNearestLink(join(api, 'src'))?.folder).toBe(api);
    expect(findNearestLink(web)?.link.serviceConfigName).toBe('web');
    expect(findNearestLink(join(root, 'apps'))?.link.serviceConfigName).toBe(
      'root',
    );
  });

  it('skips a .cloudgate folder that holds no link', () => {
    writeLink(root, shopApi);
    const nested = join(root, 'nested');
    mkdirSync(join(nested, '.cloudgate'), { recursive: true });

    expect(findNearestLink(nested)?.folder).toBe(root);
  });

  it('refuses a link it cannot read, naming the file and the fix', () => {
    mkdirSync(join(root, '.cloudgate'));
    writeFileSync(join(root, '.cloudgate', 'link.json'), '{"instance": 1');

    let thrown: unknown;
    try {
      findNearestLink(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).toContain(
      join(root, '.cloudgate', 'link.json'),
    );
    expect((thrown as CliError).hint).toMatch(/cloudgate link/);
    expect((thrown as CliError).exitCode).toBe(1);
  });
});

describe('removeLink', () => {
  it('deletes the link and its folder, and answers whether there was one', () => {
    writeLink(root, shopApi);

    expect(removeLink(root)).toBe(true);
    expect(existsSync(join(root, '.cloudgate'))).toBe(false);
    expect(findNearestLink(root)).toBeUndefined();
    expect(removeLink(root)).toBe(false);
  });

  it('keeps anything else the .cloudgate folder holds', () => {
    writeLink(root, shopApi);
    writeFileSync(join(root, '.cloudgate', 'notes.txt'), 'mine');

    removeLink(root);

    expect(existsSync(join(root, '.cloudgate', 'notes.txt'))).toBe(true);
    expect(existsSync(join(root, '.cloudgate', 'link.json'))).toBe(false);
  });
});
