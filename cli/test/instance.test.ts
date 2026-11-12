import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import {
  chooseInstance,
  instanceAddress,
  instanceEndpoints,
} from '../src/instance.js';

const link = {
  instance: 'https://cloud.acme.dev',
  file: '/work/shop/.cloudgate/link.json',
};

describe('chooseInstance', () => {
  it('takes --instance over CLOUDGATE_INSTANCE', () => {
    expect(
      chooseInstance({
        flag: 'https://cloud.acme.dev',
        env: { CLOUDGATE_INSTANCE: 'https://cloud.other.io' },
      }),
    ).toEqual({ url: 'https://cloud.acme.dev', from: 'flag' });
  });

  it('takes CLOUDGATE_INSTANCE when no flag is given', () => {
    expect(
      chooseInstance({ env: { CLOUDGATE_INSTANCE: 'https://cloud.other.io' } }),
    ).toEqual({ url: 'https://cloud.other.io', from: 'env' });
  });

  it('falls back to the hosted Instance with neither', () => {
    expect(chooseInstance({ env: {} })).toEqual({
      url: 'https://cloudgate.octabyte.app',
      from: 'default',
    });
  });

  it('treats an empty flag or variable as not given', () => {
    expect(
      chooseInstance({ flag: '', env: { CLOUDGATE_INSTANCE: '  ' } }),
    ).toEqual({ url: 'https://cloudgate.octabyte.app', from: 'default' });
  });
});

describe('chooseInstance with a Folder link', () => {
  it("takes the nearest link's Instance when neither flag nor variable is given", () => {
    expect(chooseInstance({ env: {}, link })).toEqual({
      url: 'https://cloud.acme.dev',
      from: 'link',
    });
  });

  it('takes a flag or variable that names the same Instance as the link', () => {
    expect(
      chooseInstance({ flag: 'https://CLOUD.acme.dev/', env: {}, link }).from,
    ).toBe('flag');
    expect(
      chooseInstance({
        env: { CLOUDGATE_INSTANCE: 'https://cloud.acme.dev' },
        link,
      }).from,
    ).toBe('env');
  });

  it('refuses --instance disagreeing with the link, naming both', () => {
    const refused = refusalOf(() =>
      chooseInstance({ flag: 'https://cloud.other.io', env: {}, link }),
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain('--instance https://cloud.other.io');
    expect(refused.message).toContain('https://cloud.acme.dev');
    expect(refused.message).toContain(link.file);
  });

  it('refuses CLOUDGATE_INSTANCE disagreeing with the link, naming both', () => {
    const refused = refusalOf(() =>
      chooseInstance({
        env: { CLOUDGATE_INSTANCE: 'https://cloud.other.io' },
        link,
      }),
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain(
      'CLOUDGATE_INSTANCE https://cloud.other.io',
    );
    expect(refused.message).toContain('https://cloud.acme.dev');
  });
});

describe('chooseInstance with a current Instance', () => {
  const current = 'https://cloud.other.io';

  it('takes the current Instance when nothing else names one', () => {
    expect(chooseInstance({ env: {}, current })).toEqual({
      url: current,
      from: 'current',
    });
  });

  it('takes --instance, CLOUDGATE_INSTANCE and the Folder link over it', () => {
    expect(
      chooseInstance({ flag: 'https://cloud.acme.dev', env: {}, current }),
    ).toEqual({ url: 'https://cloud.acme.dev', from: 'flag' });
    expect(
      chooseInstance({
        env: { CLOUDGATE_INSTANCE: 'https://cloud.acme.dev' },
        current,
      }),
    ).toEqual({ url: 'https://cloud.acme.dev', from: 'env' });
    expect(chooseInstance({ env: {}, link, current })).toEqual({
      url: link.instance,
      from: 'link',
    });
  });

  it('ignores it with CLOUDGATE_KEY set, falling back to the hosted Instance', () => {
    expect(
      chooseInstance({ env: { CLOUDGATE_KEY: 'cg_secret' }, current }),
    ).toEqual({ url: 'https://cloudgate.octabyte.app', from: 'default' });
  });
});

describe('instanceEndpoints', () => {
  it('reaches the REST routes under the console address, at /backend', () => {
    expect(instanceEndpoints('https://cloud.acme.dev').rest).toBe(
      'https://cloud.acme.dev/backend',
    );
  });

  it('drops a trailing slash before adding the prefix', () => {
    expect(instanceEndpoints('https://cloud.acme.dev/').rest).toBe(
      'https://cloud.acme.dev/backend',
    );
  });
});

describe('instanceEndpoints with the public answer', () => {
  it('dials WebSockets at the API origin the Instance advertises', () => {
    expect(
      instanceEndpoints('https://cloud.acme.dev', {
        apiUrl: 'https://api.acme.dev',
      }),
    ).toEqual({
      rest: 'https://cloud.acme.dev/backend',
      websocket: 'wss://api.acme.dev',
    });
    expect(
      instanceEndpoints('http://localhost:3000', {
        apiUrl: 'http://localhost:4000',
      }).websocket,
    ).toBe('ws://localhost:4000');
  });

  it('has no WebSocket base when the Instance advertises no API origin', () => {
    expect(
      instanceEndpoints('https://cloud.acme.dev', { apiUrl: null }).websocket,
    ).toBeNull();
    expect(instanceEndpoints('https://cloud.acme.dev').websocket).toBeNull();
  });
});

describe('instanceAddress', () => {
  it('adds https:// to an address given without a scheme', () => {
    expect(instanceAddress('cloud.acme.dev')).toBe('https://cloud.acme.dev');
    expect(instanceAddress('cloud.acme.dev:8443')).toBe(
      'https://cloud.acme.dev:8443',
    );
  });

  it('keeps only the origin of a pasted console URL', () => {
    expect(
      instanceAddress('https://Cloud.Acme.dev/projects/p_1?tab=logs#top'),
    ).toBe('https://cloud.acme.dev');
    expect(instanceAddress('cloud.acme.dev/projects/p_1')).toBe(
      'https://cloud.acme.dev',
    );
    expect(instanceAddress('https://cloud.acme.dev:443/')).toBe(
      'https://cloud.acme.dev',
    );
  });

  it('accepts plain http:// for localhost and 127.0.0.1', () => {
    expect(instanceAddress('http://localhost:3000/settings')).toBe(
      'http://localhost:3000',
    );
    expect(instanceAddress('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('refuses plain http:// to any other host with exit 2, naming --allow-http', () => {
    for (const address of [
      'http://cloud.acme.dev',
      'http://192.168.1.20:3000',
      'http://localhost.acme.dev',
    ]) {
      const refused = refusalOf(() => instanceAddress(address));
      expect(refused.exitCode).toBe(2);
      expect(refused.message).toBe(
        `${new URL(address).origin} is plain http://, which sends your key unencrypted`,
      );
      expect(refused.hint).toContain('--allow-http');
    }
  });

  it('accepts plain http:// to any host with --allow-http', () => {
    expect(
      instanceAddress('http://192.168.1.20:3000/', { allowHttp: true }),
    ).toBe('http://192.168.1.20:3000');
  });

  it('refuses an address that is not a web address with exit 2', () => {
    for (const address of ['ftp://cloud.acme.dev', 'https://', 'a b']) {
      expect(refusalOf(() => instanceAddress(address)).exitCode).toBe(2);
    }
  });
});

function refusalOf(act: () => unknown): CliError {
  try {
    act();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}
